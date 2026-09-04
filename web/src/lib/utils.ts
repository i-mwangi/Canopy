import { twMerge } from 'tailwind-merge';

export function cn(...classes: (string | false | null | undefined)[]): string {
    return twMerge(classes.filter(Boolean).join(' '));
}

/** Renders a USDC decimal string with two places, the way a fare is normally shown. */
export function usd(amount: string | undefined): string {
    if (amount === undefined) return '—';
    const value = Number.parseFloat(amount);
    if (Number.isNaN(value)) return '—';
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function surgeLabel(bps: number): string {
    return `${(bps / 10_000).toFixed(2)}x`;
}

export function shortAddress(address: string): string {
    if (address.length <= 10) return address;
    return `0x...${address.slice(-4)}`;
}

export function elapsedMinutes(from: number, to = Date.now()): number {
    return Math.max(0, (to - from) / 60_000);
}

export function formatDuration(minutes: number): string {
    const whole = Math.floor(minutes);
    const seconds = Math.floor((minutes - whole) * 60);
    return `${whole}m ${seconds.toString().padStart(2, '0')}s`;
}
