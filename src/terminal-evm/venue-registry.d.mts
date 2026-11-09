export type RegistryChain = 'robinhood' | 'bsc';
export interface RegistryPin { address: `0x${string}`; codeHash: `0x${string}` }
export const REGISTRY_PINS: Readonly<Record<RegistryChain, Readonly<Record<string, any>>>>;
export const REGISTRY_CLASSES: Readonly<Record<RegistryChain, readonly string[]>>;
export function registryScope(chain: string, registry: unknown): readonly string[];
export function registryClass(chain: string, route: unknown, token: unknown): string | null;
export function classContracts(chain: string, cls: string): readonly RegistryPin[];
export function verifyRegistryMarket(args: { chain: string; cls: string; route: unknown; token: string; client: any }): Promise<string>;
export function _resetRegistryCache(): void;
