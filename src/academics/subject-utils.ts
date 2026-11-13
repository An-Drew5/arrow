export function isCoreSubjectName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.startsWith("english")
    || normalized.startsWith("math")
    || normalized.startsWith("integrated science")
    || normalized.startsWith("social studies")
    || normalized === "science"
    || normalized.startsWith("science ");
}
