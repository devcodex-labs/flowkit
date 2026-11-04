const valued = new Map([['--out-dir', 'outDir'], ['--skills-root', 'skillsRoot'], ['--remote-skill-host', 'remoteSkillHosts']]);
const booleans = new Map([['--trace', ['trace', true]], ['--mermaid', ['mermaid', true]], ['--no-mermaid', ['mermaid', false]], ['--no-skill-check', ['skillCheck', false]]]);

/** Parse the two commands and six confirmed option families without creating absent overrides. */
export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new TypeError('Arguments must be strings');
  const [command, ...args] = argv;
  if (command !== 'compile' && command !== 'check') throw new TypeError('Expected command: compile or check');
  const options = {}, files = [];
  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!positionalOnly && argument === '--') { positionalOnly = true; continue; }
    if (positionalOnly || !argument.startsWith('-')) { files.push(argument); continue; }
    const equal = argument.indexOf('=');
    const name = equal < 0 ? argument : argument.slice(0, equal);
    if (booleans.has(name)) {
      if (equal >= 0) throw new TypeError(`Option ${name} does not take a value`);
      const [key, value] = booleans.get(name); options[key] = value;
    } else if (valued.has(name)) {
      const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
      if (value === undefined || !value || equal < 0 && value.startsWith('-')) throw new TypeError(`Missing value for ${name}`);
      const key = valued.get(name);
      if (key === 'remoteSkillHosts') (options[key] ??= []).push(value);
      else options[key] = value;
    } else throw new TypeError(`Unknown option: ${name}`);
  }
  if (files.length !== 1 || !/\.workflow\.(?:ts|js)$/.test(files[0])) throw new TypeError('Expected exactly one .workflow.ts or .workflow.js file');
  return { command, file: files[0], options };
}
