import fs from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';

export interface StorageService {
  readonly isS3: boolean;
  putObject(key: string, buffer: Buffer, mimeType: string): Promise<{ storageType: 's3' | 'local'; url?: string }>;
  getObject(key: string): Promise<{ buffer: Buffer; mimeType: string } | null>;
  getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string | null>;
  deleteObject(key: string): Promise<void>;
}

export class S3StorageService implements StorageService {
  readonly isS3 = true;
  private client: S3Client;
  private bucket: string;

  constructor(cfg: Config['storage']) {
    this.bucket = cfg.bucket!;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region || 'auto',
      credentials: {
        accessKeyId: cfg.accessKey!,
        secretAccessKey: cfg.secretKey!,
      },
      forcePathStyle: true,
    });
  }

  async putObject(key: string, buffer: Buffer, mimeType: string): Promise<{ storageType: 's3'; url?: string }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
    const signed = await this.getSignedDownloadUrl(key, 3600);
    return { storageType: 's3', url: signed ?? undefined };
  }

  async getObject(key: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!res.Body) return null;
      const bytes = await res.Body.transformToByteArray();
      return { buffer: Buffer.from(bytes), mimeType: res.ContentType || 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async getSignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    } catch (e) {
      console.error('[storage] error generating signed URL:', (e as Error)?.message);
      return null;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}

export class LocalStorageService implements StorageService {
  readonly isS3 = false;
  private uploadDir: string;

  constructor(uploadDir: string) {
    this.uploadDir = uploadDir;
    try {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  private resolvePath(key: string): string {
    const safeKey = key.replace(/\.\./g, '');
    return path.join(this.uploadDir, safeKey);
  }

  async putObject(key: string, buffer: Buffer, mimeType: string): Promise<{ storageType: 'local' }> {
    const filePath = this.resolvePath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
    return { storageType: 'local' };
  }

  async getObject(key: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const filePath = this.resolvePath(key);
    try {
      const buffer = await fs.promises.readFile(filePath);
      return { buffer, mimeType: 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async getSignedDownloadUrl(): Promise<string | null> {
    return null;
  }

  async deleteObject(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      /* ignore */
    }
  }
}

export function createStorageService(cfg: Config): StorageService {
  if (cfg.storage.endpoint && cfg.storage.accessKey && cfg.storage.secretKey && cfg.storage.bucket) {
    return new S3StorageService(cfg.storage);
  }
  return new LocalStorageService(cfg.storage.uploadDir);
}
