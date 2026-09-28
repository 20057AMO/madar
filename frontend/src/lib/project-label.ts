/**
 * Project names are NOT unique — the backend dedupes slugs (`-1`, `-2`, …), so
 * several live projects legitimately share a name and a name-only <option>
 * label reads as a duplicate row. The slug is what identifies a project, and it
 * is the part a user can type to find it again, so every picker shows both.
 *
 * The name is often Arabic while the slug is Latin, so the slug is wrapped in
 * Unicode bidi isolates (U+2066 LRI … U+2069 PDI): it then holds its place at
 * the end of an RTL run instead of being reordered in front of the name.
 * Isolates rather than <span dir="ltr"> because the HTML parser drops elements
 * inside <option> and option labels render as plain text — the attribute would
 * never take effect. The `title` on each option carries the copyable slug.
 */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

export function projectOptionLabel(name: string, slug: string): string {
  return `${name} · ${LRI}${slug}${PDI}`;
}
