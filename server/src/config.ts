export type AppConfig = {
  circle: {
    apiKey: string;
    entitySecret: string;
    walletSetName: string;
  };
  chain: {
    blockchain: 'ARC' | 'ARC-TESTNET';
    usdcTokenId: string;
  };
  marketplace: {
    platformFeeBps: number;
    /** Multiplier applied to the fare estimate when placing the authorization hold. */
    authorizationBufferBps: number;
    /** Operating wallet balance above which funds are swept to treasury. */
    operatingFloatCeiling: bigint;
    /** Operating wallet balance below which treasury tops it back up. */
    operatingFloatFloor: bigint;
    minimumDeposit: bigint;
    minimumWithdrawal: bigint;
    /**
     * Longest run a single rental can be billed for.
     *
     * Runtime is measured rather than estimated, so the authorization has to cover the worst
     * case. That makes this a direct lever on how much a renter must have available to
     * dispatch at all: raising it buys longer jobs at the cost of a larger hold.
     */
    maxBillableMinutes: number;
  };
  server: {
    port: number;
  };
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

function optionalUsdc(name: string, fallback: string): bigint {
  return toMinorUnits(process.env[name] ?? fallback);
}

/** USDC carries six decimals. Everything inside the ledger is an integer count of those units. */
export const USDC_DECIMALS = 6;
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

export function toMinorUnits(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid USDC amount: ${amount}`);

  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > USDC_DECIMALS) {
    throw new Error(`USDC amounts support at most ${USDC_DECIMALS} decimal places: ${amount}`);
  }

  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(USDC_DECIMALS, '0') || '0');
}

/**
 * Parses an amount reported by an upstream API, which may carry more precision than the ledger
 * keeps. Extra digits are truncated rather than rejected, since refusing to read a balance is
 * worse than reading it to the nearest minor unit.
 */
export function parseReportedAmount(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: ${amount}`);

  const [whole = '0', fraction = ''] = trimmed.split('.');
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, '0') || '0');
}

export function toDecimalString(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / USDC_SCALE;
  const fraction = (absolute % USDC_SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${rendered}` : rendered;
}

export function loadConfig(): AppConfig {

  const blockchain = (process.env.CIRCLE_BLOCKCHAIN ?? 'ARC-TESTNET') as 'ARC' | 'ARC-TESTNET';
  if (blockchain !== 'ARC' && blockchain !== 'ARC-TESTNET') {
    throw new Error(`Unsupported CIRCLE_BLOCKCHAIN: ${blockchain}`);
  }

  return {
    circle: {
      apiKey: required('CIRCLE_API_KEY'),
      entitySecret: required('CIRCLE_ENTITY_SECRET'),
      walletSetName: process.env.CIRCLE_WALLET_SET_NAME ?? 'canopy',
    },
    chain: {
      blockchain,
      usdcTokenId: required('CIRCLE_USDC_TOKEN_ID'),
    },
    marketplace: {
      platformFeeBps: optionalInt('PLATFORM_FEE_BPS', 1500),
      authorizationBufferBps: optionalInt('AUTHORIZATION_BUFFER_BPS', 13000),
      operatingFloatCeiling: optionalUsdc('OPERATING_FLOAT_CEILING', '25000'),
      operatingFloatFloor: optionalUsdc('OPERATING_FLOAT_FLOOR', '5000'),
      minimumDeposit: optionalUsdc('MINIMUM_DEPOSIT', '1'),
      minimumWithdrawal: optionalUsdc('MINIMUM_WITHDRAWAL', '5'),
      maxBillableMinutes: optionalInt('MAX_BILLABLE_MINUTES', 2),
    },
    server: {
      port: optionalInt('PORT', 8080),
    },
  };
}
