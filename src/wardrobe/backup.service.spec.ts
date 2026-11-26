import { BadRequestException } from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import { BackupService, EXPORT_FORMAT, EXPORT_VERSION } from './backup.service';

describe('BackupService.parseZip', () => {
  const service = new BackupService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { nobgFileName: (n: string) => n } as any,
    {} as any,
  );
  const zipWith = (doc: unknown) =>
    Buffer.from(zipSync({ 'libre-closet.json': strToU8(JSON.stringify(doc)) }));
  const valid = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    garments: [{ ref: 1, category: 'tops' }],
    outfits: [],
    calendar: [],
  };

  it('accepts a valid export', () => {
    const { doc } = service.parseZip(zipWith(valid));
    expect(doc.garments).toHaveLength(1);
  });

  it.each([
    ['not a zip', Buffer.from('hello'), 'Not a valid zip file'],
    [
      'zip without data file',
      Buffer.from(zipSync({ 'other.txt': strToU8('x') })),
      'does not contain',
    ],
    [
      'invalid JSON',
      Buffer.from(zipSync({ 'libre-closet.json': strToU8('{oops') })),
      'not valid JSON',
    ],
    ['foreign JSON', zipWith({ hello: 'world' }), 'Not a Libre Closet export'],
    [
      'newer version',
      zipWith({ ...valid, version: EXPORT_VERSION + 1 }),
      'Unsupported export version',
    ],
    [
      'missing sections',
      zipWith({ ...valid, outfits: undefined }),
      'missing required sections',
    ],
    [
      'garment without category',
      zipWith({ ...valid, garments: [{ ref: 1, category: ' ' }] }),
      'needs a category',
    ],
  ])('rejects %s', (_label, buffer, message) => {
    expect(() => service.parseZip(buffer)).toThrow(BadRequestException);
    expect(() => service.parseZip(buffer)).toThrow(message);
  });
});
