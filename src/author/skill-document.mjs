const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function validateSkillName(name) {
  if (typeof name !== 'string' || name.length > 64 || name !== name.trim() ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || reservedName.test(name)) {
    throw new TypeError('Use a portable Skill name with 1–64 lowercase letters, digits and single hyphens');
  }
}

export function skillDocument(name, description, body) {
  validateSkillName(name);
  if (typeof description !== 'string' || !description.trim() || [...description].length > 1024 ||
    /[\uD800-\uDFFF]/u.test(description)) {
    throw new TypeError('Skill description must contain 1–1024 Unicode characters');
  }
  const quoted = JSON.stringify(description).replace(/[\u007f-\u009f\u2028\u2029\ufffe\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `---\nname: ${name}\ndescription: ${quoted}\n---\n\n${body}\n`;
}
