export async function supportedPrimitives(): Promise<string[]> {
  const { primitiveKeys } = await import('../probes/registry.js');
  return primitiveKeys();
}
