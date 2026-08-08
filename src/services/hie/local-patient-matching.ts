type LocalCandidate = { id: number };

export function birthDateStorageWindow(birthDate: string) {
  const center = new Date(`${birthDate}T00:00:00.000Z`);
  const halfDayMs = 12 * 60 * 60 * 1000;
  return {
    gte: new Date(center.getTime() - halfDayMs),
    lte: new Date(center.getTime() + halfDayMs),
  };
}

export function prioritizeLinkedCandidates<T extends LocalCandidate>(
  linked: T[],
  demographic: T[],
  limit = 10
) {
  const seen = new Set<number>();
  return [...linked, ...demographic]
    .filter((candidate) => {
      if (seen.has(candidate.id)) {
        return false;
      }
      seen.add(candidate.id);
      return true;
    })
    .slice(0, limit);
}
