export function mergeByKey<Item, Key>(
  current: readonly Item[],
  incoming: readonly Item[],
  getKey: (item: Item) => Key,
): Item[] {
  const merged = new Map(current.map((item) => [getKey(item), item]));
  incoming.forEach((item) => merged.set(getKey(item), item));
  return Array.from(merged.values());
}

export function stabilizeByKey<Item, Key>(
  current: readonly Item[],
  incoming: readonly Item[],
  getKey: (item: Item) => Key,
  isEqual: (left: Item, right: Item) => boolean,
): Item[] {
  if (!incoming.length) return current.length ? [] : current as Item[];
  const currentByKey = new Map(current.map((item) => [getKey(item), item]));
  const stabilized = incoming.map((item) => {
    const existing = currentByKey.get(getKey(item));
    return existing !== undefined && isEqual(existing, item) ? existing : item;
  });
  return stabilized.length === current.length
    && stabilized.every((item, index) => item === current[index])
    ? current as Item[]
    : stabilized;
}

export function countBy<Item, Key extends PropertyKey>(
  items: readonly Item[],
  keys: readonly Key[],
  getKey: (item: Item) => Key,
): Record<Key, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  items.forEach((item) => { counts[getKey(item)] += 1; });
  return counts;
}
