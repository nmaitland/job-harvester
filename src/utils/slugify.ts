/**
 * Slugify utility for creating safe filenames
 */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createJobFilename(company: string, title: string): string {
  const companySlug = slugify(company);
  const titleSlug = slugify(title);
  return `${companySlug}-${titleSlug}`;
}
