/**
 * Wallet management and Polymarket CLOB client
 * With retry logic for 502/503/timeout errors
 */

import { ClobClient, AssetType } from '@polymarket/clob-client';

/**
 * Retry wrapper for CLOB client calls
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 2000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      const errorStr = String(error.message || error).toLowerCase();
      const statusCode = error.response?.status || error.status;
      
      const isRetryable = 
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode === 504 ||
        statusCode === 429 ||
        errorStr.includes('502') ||
        errorStr.includes('503') ||
        errorStr.includes('bad gateway') ||
        errorStr.includes('timeout') ||
        errorStr.includes('econnreset') ||
        errorStr.includes('enotfound') ||
        errorStr.includes('network');
      
      if (isRetryable && attempt < maxRetries) {
        const waitTime = delayMs * attempt;
        console.log(`  ⚠️ CLOB error (${statusCode || 'network'}), retry ${attempt}/${maxRetries} in ${waitTime/1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}
import { Wallet } from '@ethersproject/wallet';
import { providers, Contract, BigNumber, utils } from 'ethers';
import { formatUnits, formatEther } from '@ethersproject/units';
import logger from './logger';

// Polygon contracts
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';  // USDC (bridged)
const USDC_E_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // USDC.e (native)
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
const POLYGON_RPC = 'https://polygon-rpc.com';
const CLOB_API = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
];

const PROXY_FACTORY_ABI = [
  'function getPolyProxy(address) view returns (address)',
];

export interface WalletBalance {
  // Addresses
  eoaAddress: string;
  proxyAddress: string | null;
  
  // On-chain balances (EOA)
  matic: number;
  usdcWallet: number;
  usdceWallet: number;
  
  // Trading wallet (proxy) balances
  usdcProxy: number;
  usdceProxy: number;
  
  // Polymarket collateral (via API)
  polymarketBalance: number;
  
  // Allowances
  allowanceCTF: number;
  allowanceNegRisk: number;
}

export class WalletManager {
  private wallet: Wallet;
  private provider: providers.JsonRpcProvider;
  private clobClient: ClobClient;
  private authClient: ClobClient | null = null;
  private usdcContract: Contract;
  private usdceContract: Contract;
  private proxyFactory: Contract;
  private proxyAddress: string | null = null;
  private privateKey: string;
  private initialized: boolean = false;
  
  // Balance cache to reduce CLOB API calls
  private balanceCache: { balance: number; allowanceCTF: number; allowanceNegRisk: number } | null = null;
  private balanceCacheTime: number = 0;
  private readonly BALANCE_CACHE_TTL = 30000; // 30 seconds

  constructor(privateKey: string, funderAddress?: string) {
    if (!privateKey) {
      throw new Error('Private key is required');
    }

    const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this.privateKey = key;
    
    this.provider = new providers.JsonRpcProvider(POLYGON_RPC);
    this.wallet = new Wallet(key, this.provider);
    
    // If funderAddress (trading wallet) is provided, use it
    if (funderAddress) {
      this.proxyAddress = funderAddress;
    }
    
    this.usdcContract = new Contract(USDC_ADDRESS, ERC20_ABI, this.provider);
    this.usdceContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, this.provider);
    this.proxyFactory = new Contract(PROXY_FACTORY, PROXY_FACTORY_ABI, this.provider);
    
    // Initialize ClobClient (will be reconfigured in initialize())
    this.clobClient = new ClobClient(CLOB_API, CHAIN_ID, this.wallet);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // If proxy address not set, try to fetch it
      if (!this.proxyAddress) {
        await this.fetchProxyAddress();
      }
      
      // Setup API credentials
      const creds = await this.clobClient.deriveApiKey();
      
      // Create authenticated client with funderAddress (trading wallet)
      // SignatureType: 0 = EOA, 1 = Poly Proxy (MagicLink), 2 = Gnosis Safe (MetaMask)
      // Most MetaMask users have Gnosis Safe proxy wallets
      const signatureType = this.proxyAddress ? 2 : 0; // Use Gnosis Safe for proxy
      
      this.authClient = new ClobClient(
        CLOB_API, 
        CHAIN_ID, 
        this.wallet, 
        creds,
        signatureType,
        this.proxyAddress || undefined  // funderAddress
      );
      
      this.initialized = true;
    } catch (error: any) {
      console.log('⚠️  Could not derive API key - trying to create new one...');
      try {
        const creds = await this.clobClient.createApiKey();
        const signatureType = this.proxyAddress ? 2 : 0; // Gnosis Safe for MetaMask users
        
        this.authClient = new ClobClient(
          CLOB_API, 
          CHAIN_ID, 
          this.wallet, 
          creds,
          signatureType,
          this.proxyAddress || undefined
        );
        
        this.initialized = true;
        console.log('✅ API key created successfully');
      } catch (e: any) {
        console.log('⚠️  API setup failed (wallet may need registration on polymarket.com)');
        this.initialized = true;
      }
    }
  }

  /**
   * Get proxy wallet (trading wallet) address from ProxyFactory
   */
  async fetchProxyAddress(): Promise<string | null> {
    try {
      const calldata = new utils.Interface(PROXY_FACTORY_ABI)
        .encodeFunctionData('getPolyProxy', [this.wallet.address]);
      
      const result = await this.provider.call({
        to: PROXY_FACTORY,
        data: calldata
      });
      
      if (result && result !== '0x' && result !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        this.proxyAddress = utils.defaultAbiCoder.decode(['address'], result)[0];
        console.log(`📍 Trading Wallet: ${this.proxyAddress}`);
      } else {
        console.log('📍 No Trading Wallet found (not yet created on Polymarket)');
        this.proxyAddress = null;
      }
    } catch (error) {
      this.proxyAddress = null;
    }
    
    return this.proxyAddress;
  }

  getAddress(): string {
    return this.wallet.address;
  }

  getProxyAddress(): string | null {
    return this.proxyAddress;
  }

  getPrivateKey(): string {
    return this.privateKey;
  }

  /**
   * Get Polymarket collateral balance via API (with caching)
   */
  async getPolymarketBalance(forceRefresh: boolean = false): Promise<{ balance: number; allowanceCTF: number; allowanceNegRisk: number }> {
    if (!this.authClient) {
      return { balance: 0, allowanceCTF: 0, allowanceNegRisk: 0 };
    }

    // Return cached balance if still valid
    const now = Date.now();
    if (!forceRefresh && this.balanceCache && (now - this.balanceCacheTime) < this.BALANCE_CACHE_TTL) {
      return this.balanceCache;
    }

    try {
      const result = await withRetry(() => this.authClient!.getBalanceAllowance({ 
        asset_type: AssetType.COLLATERAL 
      }));
      
      const balance = parseFloat(result.balance || '0') / 1e6;
      // API returns 'allowances' object but types say 'allowance' string
      const allowances = (result as any).allowances || {};
      const allowanceCTF = parseFloat(allowances[CTF_EXCHANGE] || '0') / 1e6;
      const allowanceNegRisk = parseFloat(allowances[NEG_RISK_CTF_EXCHANGE] || '0') / 1e6;
      
      // Update cache
      this.balanceCache = { balance, allowanceCTF, allowanceNegRisk };
      this.balanceCacheTime = now;
      
      return this.balanceCache;
    } catch (error) {
      // Return cached value on error if available
      if (this.balanceCache) {
        return this.balanceCache;
      }
      return { balance: 0, allowanceCTF: 0, allowanceNegRisk: 0 };
    }
  }

  /**
   * Invalidate balance cache (call after trades)
   */
  invalidateBalanceCache(): void {
    this.balanceCache = null;
    this.balanceCacheTime = 0;
  }

  /**
   * Get all balances
   */
  async getBalance(): Promise<WalletBalance> {
    const eoaAddress = this.wallet.address;

    try {
      // Fetch EOA balances
      const [maticBalance, usdcEoa, usdceEoa] = await Promise.all([
        this.provider.getBalance(eoaAddress),
        this.usdcContract.balanceOf(eoaAddress).catch(() => BigNumber.from(0)),
        this.usdceContract.balanceOf(eoaAddress).catch(() => BigNumber.from(0)),
      ]);

      // Fetch proxy wallet balances if available
      let usdcProxy = BigNumber.from(0);
      let usdceProxy = BigNumber.from(0);
      
      if (this.proxyAddress) {
        [usdcProxy, usdceProxy] = await Promise.all([
          this.usdcContract.balanceOf(this.proxyAddress).catch(() => BigNumber.from(0)),
          this.usdceContract.balanceOf(this.proxyAddress).catch(() => BigNumber.from(0)),
        ]);
      }

      // Get Polymarket API balance
      const polyBalance = await this.getPolymarketBalance();

      return {
        eoaAddress,
        proxyAddress: this.proxyAddress,
        matic: parseFloat(formatEther(maticBalance)),
        usdcWallet: parseFloat(formatUnits(usdcEoa, 6)),
        usdceWallet: parseFloat(formatUnits(usdceEoa, 6)),
        usdcProxy: parseFloat(formatUnits(usdcProxy, 6)),
        usdceProxy: parseFloat(formatUnits(usdceProxy, 6)),
        polymarketBalance: polyBalance.balance,
        allowanceCTF: polyBalance.allowanceCTF,
        allowanceNegRisk: polyBalance.allowanceNegRisk,
      };
    } catch (error: any) {
      logger.errorDetail('Error fetching balances', error);
      return {
        eoaAddress,
        proxyAddress: this.proxyAddress,
        matic: 0,
        usdcWallet: 0,
        usdceWallet: 0,
        usdcProxy: 0,
        usdceProxy: 0,
        polymarketBalance: 0,
        allowanceCTF: 0,
        allowanceNegRisk: 0,
      };
    }
  }

  /**
   * Display balance info
   */
  async displayBalance(): Promise<WalletBalance> {
    const balance = await this.getBalance();
    // Trading wallet balance = max of on-chain proxy balance or API balance (they're the same funds)
    const tradingBalance = Math.max(balance.usdcProxy + balance.usdceProxy, balance.polymarketBalance);
    const totalUsdc = balance.usdcWallet + balance.usdceWallet + tradingBalance;
    
    console.log('═'.repeat(60));
    console.log('💰 WALLET BALANCE');
    console.log('═'.repeat(60));
    
    console.log('\n📍 Addresses:');
    console.log(`   EOA (Signer):     ${balance.eoaAddress}`);
    if (balance.proxyAddress) {
      console.log(`   Trading Wallet:   ${balance.proxyAddress}`);
    } else {
      console.log(`   Trading Wallet:   ❌ Not found`);
    }
    
    console.log('\n📦 EOA Balances:');
    console.log(`   MATIC:  ${balance.matic.toFixed(4)} POL`);
    console.log(`   USDC:   $${balance.usdcWallet.toFixed(2)}`);
    if (balance.usdceWallet > 0) {
      console.log(`   USDC.e: $${balance.usdceWallet.toFixed(2)}`);
    }
    
    if (balance.proxyAddress) {
      console.log('\n🎯 Trading Wallet Balances:');
      console.log(`   USDC:   $${balance.usdcProxy.toFixed(2)}`);
      if (balance.usdceProxy > 0) {
        console.log(`   USDC.e: $${balance.usdceProxy.toFixed(2)}`);
      }
    }
    
    if (balance.polymarketBalance > 0) {
      console.log('\n📊 Polymarket API:');
      console.log(`   Collateral: $${balance.polymarketBalance.toFixed(2)}`);
    }
    
    console.log('\n📋 Trading Allowances:');
    const formatAllowance = (val: number) => {
      if (val > 1e12) return '✅ Unlimited';
      if (val > 0) return `$${val.toFixed(2)}`;
      return '❌ Not set';
    };
    console.log(`   CTF Exchange:     ${formatAllowance(balance.allowanceCTF)}`);
    console.log(`   NegRisk Exchange: ${formatAllowance(balance.allowanceNegRisk)}`);
    
    console.log('\n' + '═'.repeat(60));
    console.log(`💵 TOTAL USDC AVAILABLE: $${totalUsdc.toFixed(2)}`);
    console.log('═'.repeat(60));

    if (totalUsdc < 5) {
      console.log('\n⚠️  Low USDC! Deposit funds on polymarket.com.');
    }
    if (!balance.proxyAddress) {
      console.log('\n💡 Trading wallet not found. Add FUNDER_ADDRESS to .env');
    }

    return balance;
  }

  getClobClient(): ClobClient {
    if (!this.authClient) {
      throw new Error('Wallet not initialized. Call initialize() first.');
    }
    return this.authClient;
  }

  async checkSufficientBalance(requiredUsdc: number): Promise<boolean> {
    const balance = await this.getBalance();
    const totalUsdc = balance.usdcWallet + balance.usdcProxy + balance.polymarketBalance;
    return totalUsdc >= requiredUsdc;
  }
}

// Singleton instance
let walletInstance: WalletManager | null = null;

export function getWallet(): WalletManager {
  if (!walletInstance) {
    const privateKey = process.env.PRIVATE_KEY;
    const funderAddress = process.env.FUNDER_ADDRESS || process.env.TRADING_WALLET;
    
    if (!privateKey) {
      throw new Error('PRIVATE_KEY not found in environment variables');
    }
    walletInstance = new WalletManager(privateKey, funderAddress);
  }
  return walletInstance;
}

export async function initializeWallet(): Promise<WalletManager> {
  const wallet = getWallet();
  await wallet.initialize();
  return wallet;
}
