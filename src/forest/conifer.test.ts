import { describe, expect, it } from 'vitest';
import { buildConifers, variantIndex, VARIANT_COUNT } from './conifer';

describe('conifer generator', () => {
  const variants = buildConifers();

  it('builds every variant with two LODs inside the triangle budgets', () => {
    expect(variants).toHaveLength(VARIANT_COUNT);
    for (const v of variants) {
      expect(v.lods[0].triangles).toBeGreaterThan(v.lods[1].triangles);
      expect(v.lods[0].triangles).toBeLessThan(14000);
      expect(v.lods[1].triangles).toBeLessThan(2600);
      expect(v.profile.every((r) => r > 0)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const a = buildConifers()[1]!.lods[0].foliage!.getAttribute('position').array;
    expect(a[0]).toBe(variants[1]!.lods[0].foliage!.getAttribute('position').array[0]);
  });

  it('foliage shading normals point out of the crown', () => {
    for (const v of variants) {
      const g = v.lods[0].foliage;
      if (!g) continue;
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      let out = 0;
      let total = 0;
      for (let i = 0; i < p.count; i++) {
        const r = Math.hypot(p.getX(i), p.getY(i));
        if (r < 0.5) continue;
        total++;
        if ((p.getX(i) * n.getX(i) + p.getY(i) * n.getY(i)) / r > 0) out++;
      }
      expect(out / total).toBeGreaterThan(0.9);
    }
  });

  it('picks young variants for small trees', () => {
    expect(variantIndex(0, 4, 8)).toBe(2);
    expect(variantIndex(0, 4, 25)).toBe(0);
    expect(variantIndex(0, 5, 25)).toBe(1);
    expect(variantIndex(3, 5, 5)).toBe(9);
  });
});
