import { isCoreVersionCompatible } from './core-version';

describe('isCoreVersionCompatible', () => {
  it('^0.x.y: compatible with same major.minor, patch >=', () => {
    expect(isCoreVersionCompatible('^0.1.0', '0.1.0-p1')).toBe(true);
    expect(isCoreVersionCompatible('^0.1.0', '0.1.5')).toBe(true);
    expect(isCoreVersionCompatible('^0.1.5', '0.1.0')).toBe(false);
    expect(isCoreVersionCompatible('^0.1.0', '0.2.0')).toBe(false);
    expect(isCoreVersionCompatible('^0.1.0', '1.0.0')).toBe(false);
  });

  it('^X.Y.Z (major >= 1): compatible within the same major, >= minor.patch', () => {
    expect(isCoreVersionCompatible('^1.2.0', '1.2.0')).toBe(true);
    expect(isCoreVersionCompatible('^1.2.0', '1.3.0')).toBe(true);
    expect(isCoreVersionCompatible('^1.2.0', '2.0.0')).toBe(false);
    expect(isCoreVersionCompatible('^1.2.0', '1.1.9')).toBe(false);
  });

  it('>=X.Y.Z: no upper bound', () => {
    expect(isCoreVersionCompatible('>=0.1.0', '5.0.0')).toBe(true);
    expect(isCoreVersionCompatible('>=1.0.0', '0.9.0')).toBe(false);
  });

  it('exact match fallback for anything else', () => {
    expect(isCoreVersionCompatible('0.1.0-p1', '0.1.0-p1')).toBe(true);
    expect(isCoreVersionCompatible('0.1.0-p1', '0.1.0-p2')).toBe(false);
  });
});
