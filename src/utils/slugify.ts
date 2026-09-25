/**
 * Slugify utility for creating safe filenames
 */

// Slugs end up in filenames next to timestamps and ids; the filesystem limit is 255
// bytes, and a scraped "company" can be a whole news headline.
const MAX_SLUG_LENGTH = 60;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
}

export function createJobFilename(company: string, title: string): string {
  const companySlug = slugify(company);
  const titleSlug = slugify(title);
  return `${companySlug}-${titleSlug}`;
}
