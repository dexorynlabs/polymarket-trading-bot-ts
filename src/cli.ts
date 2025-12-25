import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Config, SizingMode } from './config';
import { startBot } from './bot';
import { initializeWallet } from './wallet';
import { setAllowancesFromEnv } from './relayer';
import { PolymarketAPI } from './api';
import { RealTrader } from './trader';

const CONFIG_FILE = join(process.cwd(), 'config.json');

function loadConfigFromFile(): Config | null {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading config file:', error);
    return null;
  }
}

function saveConfigToFile(config: Config): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('✅ Configuration saved successfully!');
  } catch (error) {
    console.error('❌ Error saving config file:', error);
  }
}

function getConfig(): Config {
  const fileConfig = loadConfigFromFile();
  if (fileConfig) {
    return fileConfig;
  }
  // Return default config
  return {
    wallets_to_track: [],
    mode: 'proportional',
    min_stake: 5,
    max_stake: 300,
    profit_take_percent: 15,
  };
}

const program = new Command();

program
  .name('polymarket-bot')
  .description('Polymarket Copy Trading Bot - CLI')
  .version('0.1.0');

// Start command
program
  .command('start')
  .description('Start the copy trading bot')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    const config = getConfig();
    
    if (config.wallets_to_track.length === 0) {
      console.error('❌ No wallets configured. Please add wallets first:');
      console.log('   npm run cli wallets add <address>\n');
      process.exit(1);
    }

    if (!process.env.PRIVATE_KEY) {
      console.error('❌ PRIVATE_KEY not found in .env file!');
      console.log('\n💡 Add your private key to .env:');
      console.log('   PRIVATE_KEY=0xYourPrivateKeyHere\n');
      process.exit(1);
    }

    await startBot(config, options.verbose);
  });

// Balance command
program
  .command('balance')
  .description('Check your wallet balance')
  .action(async () => {
    if (!process.env.PRIVATE_KEY) {
      console.error('❌ PRIVATE_KEY not found in .env file!');
      console.log('\n💡 Add your private key to .env:');
      console.log('   PRIVATE_KEY=0xYourPrivateKeyHere\n');
      process.exit(1);
    }

    try {
      console.log('🔍 Checking wallet balance...\n');
      const wallet = await initializeWallet();
      await wallet.displayBalance();
    } catch (error: any) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

// Config command
program
  .command('config')
  .description('Configure bot settings')
  .option('-m, --mode <mode>', 'Sizing mode: fixed or proportional', (value) => {
    if (value !== 'fixed' && value !== 'proportional') {
      throw new Error('Mode must be "fixed" or "proportional"');
    }
    return value as SizingMode;
  })
  .option('-s, --stake <amount>', 'Fixed stake amount', parseFloat)
  .option('--min-stake <amount>', 'Minimum stake amount', parseFloat)
  .option('--max-stake <amount>', 'Maximum stake amount', parseFloat)
  .option('-p, --profit <percent>', 'Profit take percentage', parseFloat)
  .action((options) => {
    const config = getConfig();
    let updated = false;

    if (options.mode) {
      config.mode = options.mode;
      updated = true;
      console.log(`✅ Mode set to: ${options.mode}`);
    }

    if (options.stake !== undefined) {
      config.fixed_stake = options.stake;
      updated = true;
      console.log(`✅ Fixed stake set to: $${options.stake}`);
    }

    if (options.minStake !== undefined) {
      config.min_stake = options.minStake;
      updated = true;
      console.log(`✅ Min stake set to: $${options.minStake}`);
    }

    if (options.maxStake !== undefined) {
      config.max_stake = options.maxStake;
      updated = true;
      console.log(`✅ Max stake set to: $${options.maxStake}`);
    }

    if (options.profit !== undefined) {
      config.profit_take_percent = options.profit;
      updated = true;
      console.log(`✅ Profit take set to: ${options.profit}%`);
    }

    if (updated) {
      saveConfigToFile(config);
    } else {
      console.log('\n📋 Current Configuration:');
      console.log(JSON.stringify(config, null, 2));
      console.log('\n💡 Use --help to see available options');
    }
  });

// Wallets command group
const walletsCommand = program
  .command('wallets')
  .description('Manage wallets to track');

walletsCommand
  .command('list')
  .alias('ls')
  .description('List all tracked wallets')
  .action(() => {
    const config = getConfig();
    if (config.wallets_to_track.length === 0) {
      console.log('📭 No wallets configured');
    } else {
      console.log('📋 Tracked Wallets:');
      config.wallets_to_track.forEach((wallet, index) => {
        console.log(`   ${index + 1}. ${wallet}`);
      });
    }
  });

walletsCommand
  .command('add <address>')
  .description('Add a wallet address to track')
  .action((address: string) => {
    const config = getConfig();
    if (config.wallets_to_track.includes(address)) {
      console.log(`⚠️  Wallet ${address} is already being tracked`);
      return;
    }
    config.wallets_to_track.push(address);
    saveConfigToFile(config);
    console.log(`✅ Added wallet: ${address}`);
  });

walletsCommand
  .command('remove <address>')
  .alias('rm')
  .description('Remove a wallet address from tracking')
  .action((address: string) => {
    const config = getConfig();
    const index = config.wallets_to_track.indexOf(address);
    if (index === -1) {
      console.log(`❌ Wallet ${address} not found in tracked wallets`);
      return;
    }
    config.wallets_to_track.splice(index, 1);
    saveConfigToFile(config);
    console.log(`✅ Removed wallet: ${address}`);
  });

// Status command
program
  .command('status')
  .description('Show bot status and configuration')
  .action(() => {
    const config = getConfig();
    const hasPrivateKey = !!process.env.PRIVATE_KEY;
    
    console.log('\n📊 Bot Status\n');
    console.log('Wallet:');
    console.log(`   Private Key: ${hasPrivateKey ? '✅ Configured' : '❌ Not set'}`);
    
    console.log('\nConfiguration:');
    console.log(`   Mode: ${config.mode}`);
    console.log(`   Stake Range: $${config.min_stake} - $${config.max_stake}`);
    console.log(`   Profit Take: ${config.profit_take_percent}%`);
    console.log(`\nTracked Wallets: ${config.wallets_to_track.length}`);
    if (config.wallets_to_track.length > 0) {
      config.wallets_to_track.forEach((wallet, index) => {
        console.log(`   ${index + 1}. ${wallet}`);
      });
    } else {
      console.log('   ⚠️  No wallets configured');
    }
    console.log('');
  });

// Set Allowances command
program
  .command('set-allowances')
  .description('Set trading allowances for your Polymarket wallet (required once)')
  .action(async () => {
    if (!process.env.PRIVATE_KEY) {
      console.error('❌ PRIVATE_KEY not found in .env file!');
      console.log('\n💡 Add your private key to .env:');
      console.log('   PRIVATE_KEY=0xYourPrivateKeyHere\n');
      process.exit(1);
    }

    if (!process.env.FUNDER_ADDRESS) {
      console.error('❌ FUNDER_ADDRESS not found in .env file!');
      console.log('\n💡 Add your Polymarket trading wallet address to .env:');
      console.log('   FUNDER_ADDRESS=0xYourTradingWalletHere');
      console.log('\n   (This is the address shown below your profile picture on polymarket.com)\n');
      process.exit(1);
    }

    console.log('🔧 Setting trading allowances via Polymarket relayer...\n');
    console.log('This is a one-time setup required before trading.\n');

    try {
      await setAllowancesFromEnv();
      console.log('\n✅ Allowances set successfully!');
      console.log('You can now trade using the bot.');
    } catch (error: any) {
      console.error('\n❌ Error setting allowances:', error.message);
      console.log('\n💡 If this fails, you can set allowances manually on polymarket.com');
      process.exit(1);
    }
  });

// Init command
program
  .command('init')
  .description('Initialize bot configuration')
  .action(() => {
    console.log('🔧 Initializing Polymarket Copy Trading Bot...\n');
    const config = getConfig();
    
    if (existsSync(CONFIG_FILE)) {
      console.log('⚠️  Config file already exists. Use "config" command to modify settings.\n');
      return;
    }

    saveConfigToFile(config);
    console.log('✅ Configuration initialized!');
    console.log('\nNext steps:');
    console.log('1. Copy env.example to .env and add your PRIVATE_KEY');
    console.log('2. Add wallets: npm run cli wallets add <address>');
    console.log('3. Check balance: npm run cli balance');
    console.log('4. Start bot: npm run bot\n');
  });

// Close All Positions command
program
  .command('close-all')
  .description('Close all open positions (market sell)')
  .option('--yes', 'Skip confirmation')
  .action(async (options) => {
    if (!process.env.PRIVATE_KEY) {
      console.error('❌ PRIVATE_KEY not found in .env file!');
      process.exit(1);
    }

    console.log('🔍 Fetching positions...\n');
    
    try {
      const wallet = await initializeWallet();
      const walletAddress = wallet.getProxyAddress() || wallet.getAddress();
      
      const api = new PolymarketAPI();
      const positions = await api.getWalletPositions(walletAddress);
      
      const openPositions = positions.filter(p => p.size > 0.01);
      
      if (openPositions.length === 0) {
        console.log('✅ No open positions to close');
        return;
      }
      
      console.log(`📊 Found ${openPositions.length} position(s):\n`);
      
      let totalValue = 0;
      for (const pos of openPositions) {
        const value = pos.size * (pos.currentPrice || pos.avgPrice);
        totalValue += value;
        console.log(`   ${pos.marketSlug?.substring(0, 40) || pos.tokenId.substring(0, 16)}`);
        console.log(`   Size: ${pos.size.toFixed(2)} | Value: $${value.toFixed(2)}\n`);
      }
      
      console.log(`💰 Total Value: $${totalValue.toFixed(2)}\n`);
      
      if (!options.yes) {
        console.log('⚠️  This will sell ALL positions at market price!');
        console.log('   Run with --yes to confirm\n');
        return;
      }
      
      console.log('🚀 Closing all positions...\n');
      
      const trader = new RealTrader();
      await trader.initialize();
      
      // Cancel all open orders first
      const cancelled = await trader.cancelAllOrders();
      if (cancelled > 0) {
        console.log(`  ✅ Cancelled ${cancelled} open order(s)\n`);
      }
      
      const result = await trader.closeAllPositions(openPositions.map(p => ({
        tokenId: p.tokenId,
        size: p.size,
        currentPrice: p.currentPrice || p.avgPrice,
        marketSlug: p.marketSlug,
      })));
      
      console.log(`\n✅ Done! Closed: ${result.closed}, Failed: ${result.failed}`);
      
    } catch (error: any) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

export function runCLI(): void {
  program.parse();
}
