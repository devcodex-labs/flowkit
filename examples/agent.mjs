/** Obey the small instruction vocabulary of the checked-in demo Skills; this is not a model. */
export async function exampleAgent(step, { reviewOk = true } = {}) {
  const instruction = step.instruction.replace(/`/g, '').replace(/\s+/g, ' ');
  // The archived instruction really requested a boolean, incompatible with an object schema.
  if (instruction.includes('检查 draft，通过时返回 true。')) return true;
  if (!instruction.includes('Return a JSON object')) throw new Error('Unsupported example instruction');
  const result = {};
  for (const key of Object.keys(step.resultSchema.properties ?? {})) {
    if (!instruction.includes(key)) throw new Error(`Instruction does not describe ${key}`);
    if (key === 'draft') result[key] = `关于 ${step.input.topic} 的演示文章`;
    else if (key === 'styleOk' || key === 'factOk') result[key] = reviewOk;
    else if (key === 'styleNotes') result[key] = '结构清晰';
    else if (key === 'factNotes') result[key] = '演示证据已核对';
    else throw new Error(`Unsupported example output: ${key}`);
  }
  return result;
}
