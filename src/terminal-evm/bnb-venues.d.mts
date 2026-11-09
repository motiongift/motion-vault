export type BnbTerminalVenue = 'v3' | 'inf' | 'four' | 'flap';
export const BNB_EXTRA_VENUES: readonly BnbTerminalVenue[];
export const FOUR_SELL_QUANTUM: bigint;
export const BNB_PINS: Readonly<{ v3Factory: string; clPoolManager: string; wrapped: string }>;
export function bnbTerminalVenues(flag: unknown): readonly BnbTerminalVenue[];
export function enabledTerminalVenueTypes(chain: string, flag: unknown): readonly string[];
export function infPoolId(poolKey: unknown): `0x${string}`;
export function terminalSellAmount(args: { balance: bigint; pctBps: number; route: unknown }): bigint;
export function verifyBnbVenue(args: { route: any; token: string; side: 'buy' | 'sell'; amount: bigint; client: any }): Promise<void>;
