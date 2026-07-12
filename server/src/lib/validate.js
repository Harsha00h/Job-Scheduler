const { ApiError } = require('./errors');

// Small declarative validator to keep route handlers clean without
// pulling in a full schema library.
// spec: { field: { required, type: 'string'|'number'|'boolean'|'object'|'array', enum, min, max } }
function validate(body, spec) {
  const errors = [];
  const out = {};
  for (const [field, rules] of Object.entries(spec)) {
    const value = body ? body[field] : undefined;
    if (value === undefined || value === null) {
      if (rules.required) errors.push(`${field} is required`);
      else if ('default' in rules) out[field] = rules.default;
      continue;
    }
    if (rules.type === 'array' ? !Array.isArray(value) : rules.type && typeof value !== rules.type) {
      errors.push(`${field} must be a ${rules.type}`);
      continue;
    }
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push(`${field} must be one of: ${rules.enum.join(', ')}`);
      continue;
    }
    if (rules.type === 'number' && rules.min !== undefined && value < rules.min) {
      errors.push(`${field} must be >= ${rules.min}`);
      continue;
    }
    if (rules.type === 'number' && rules.max !== undefined && value > rules.max) {
      errors.push(`${field} must be <= ${rules.max}`);
      continue;
    }
    if (rules.type === 'string' && rules.required && value.trim() === '') {
      errors.push(`${field} must not be empty`);
      continue;
    }
    out[field] = value;
  }
  if (errors.length) throw ApiError.badRequest('Validation failed', errors);
  return out;
}

// Parses ?page=&limit= with sane bounds; returns SQL-ready offset.
function pagination(query, defaultLimit = 25, maxLimit = 100) {
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit || String(defaultLimit), 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = { validate, pagination };
