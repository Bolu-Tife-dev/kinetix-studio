import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface AppSettings {
  apiKey: string;
  apiEnabled: boolean;
  port: number;
  autoStartServer: boolean;
  defaultTransition: 'glitch' | 'flash' | 'fade' | 'cut' | 'zoom-punch';
}

const DEFAULTS: Omit<AppSettings, 'apiKey'> = {
  apiEnabled: true,
  port: 4815,
  autoStartServer: true,
  defaultTransition: 'glitch',
};

/** Persists user settings (incl. the generated API key) in userData/settings.json. */
export class SettingsService {
  private filePath: string;
  private settings: AppSettings;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'settings.json');
    this.settings = { ...DEFAULTS, apiKey: generateApiKey() };
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      this.settings = {
        ...DEFAULTS,
        ...parsed,
        apiKey: parsed.apiKey && parsed.apiKey.length > 0 ? parsed.apiKey : generateApiKey(),
      };
    } catch {
      await this.save();
    }
    return this.get();
  }

  async save(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    await this.save();
    return this.get();
  }

  async rotateApiKey(): Promise<string> {
    this.settings.apiKey = generateApiKey();
    await this.save();
    return this.settings.apiKey;
  }

  verifyKey(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    // Constant-time comparison.
    const expected = Buffer.from(this.settings.apiKey);
    const got = Buffer.from(candidate);
    if (expected.length !== got.length) return false;
    return timingSafeEqual(expected, got);
  }
}

export function generateApiKey(): string {
  return `kx_${randomBytes(24).toString('hex')}`;
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
