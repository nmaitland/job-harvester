import { slugify } from '../utils/slugify';

describe('slugify', () => {
  it('caps length so a headline-sized company name cannot overflow a filename', () => {
    const headline = 'the shaded gap beneath rooftop solar panels can become a nesting spot for pigeons and experts say a simple mesh barrier may work better';
    const slug = slugify(headline);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toMatch(/^the-shaded-gap-beneath/);
    expect(slug).not.toMatch(/-$/);
  });

  it('keeps short names intact', () => {
    expect(slugify('Acme AG (Zurich)')).toBe('acme-ag-zurich');
  });
});
