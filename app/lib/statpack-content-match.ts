interface ContentIdentity {
  itemId: string;
  pocket?: string;
  compartmentId?: string;
  batchId?: string;
  serialNumber?: string;
}

/** Every supplied location/lot qualifier must agree; never fall back to another pocket. */
export function findStatpackContentIndex(
  contents: ContentIdentity[],
  entry: ContentIdentity,
  used: ReadonlySet<number>,
): number {
  const qualifiers = ['pocket', 'compartmentId', 'batchId', 'serialNumber'] as const;
  return contents.findIndex((content, index) =>
    !used.has(index) && content.itemId === entry.itemId &&
    qualifiers.every(key => !entry[key] || content[key] === entry[key]),
  );
}
