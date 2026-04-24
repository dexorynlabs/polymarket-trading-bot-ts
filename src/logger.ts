/**
 * Simple logger with DEBUG mode support
 */

const isDebug = process.env.DEBUG === 'true';

export const logger = {
  /**
   * Always show - important info
   */
  info: (msg: string) => console.log(msg),

  /**
   * Always show - success
   */
  success: (msg: string) => console.log(`✅ ${msg}`),

  /**
   * Always show - warning
   */
  warn: (msg: string) => console.log(`⚠️  ${msg}`),

  /**
   * Short error - always shown
   */
  error: (msg: string) => console.log(`❌ ${msg}`),

  /**
   * Detailed error - only in DEBUG mode
   */
  errorDetail: (msg: string, error: any) => {
    console.log(`❌ ${msg}`);
    if (isDebug && error) {
      console.log(`   Details: ${error.message || error}`);
      if (error.stack) {
        console.log(`   Stack: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
      }
    }
  },

  /**
   * Debug info - only in DEBUG mode
   */
  debug: (msg: string) => {
    if (isDebug) {
      console.log(`🔍 ${msg}`);
    }
  },
};

export default logger;

