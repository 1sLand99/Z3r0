export function shallowEqual(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value]) => Object.is(value, Reflect.get(right, key)));
}
