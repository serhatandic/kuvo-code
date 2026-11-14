// Types for browser-source-stand-in.js, for the box's tests (box/test).
export interface ZipEntry { name: string; data?: string | Uint8Array; mode?: number; link?: string; deflate?: boolean; claimedSize?: number }
export interface ArchiveFile { name: string; data?: string | Uint8Array; mode?: number; link?: string }
export interface System { version: string; x86_64: Buffer; aarch64: Buffer; packages?: Record<string, { name: string; rpm: Buffer; repo?: string }[]> }
export function crc32(data: Uint8Array): number;
export function makeZip(entries: ZipEntry[]): Buffer;
export function makeXz(data: Uint8Array): Buffer;
export function makeCpio(files: ArchiveFile[]): Buffer;
export function makeRpm(files: ArchiveFile[], options?: { payload?: Buffer }): Buffer;
export function makePins(systems: { linux?: System; darwin?: System }): Record<string, unknown>;
export function served(systems: { linux?: System; darwin?: System }): { pins: Record<string, unknown>; files: Map<string, Buffer> };
export function startSource(files: Map<string, Buffer>, answer?: (address: string) => { status: number; headers?: Record<string, string>; body?: string | Buffer; slow?: number } | null): Promise<{ url: string; asked: string[]; close: () => Promise<void> }>;
