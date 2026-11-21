import type { TargetSchemaInput } from './target-schema.types.js';

/**
 * The "Customer 360" schema every project starts with. Same fields as
 * eval/samples/answers/target_schema.json (the evaluation's answer key), plus `required` and
 * `allowConcat`, which the answer key does not need.
 */
export const CUSTOMER_360: TargetSchemaInput = {
  name: 'Customer 360',
  fields: [
    {
      name: 'customer_id',
      type: 'string',
      format: null,
      description:
        'One unique id per real person, created by DataBridge after duplicates are merged (not taken from any source).',
      isPii: false,
      generated: true,
      required: true,
      allowConcat: false,
    },
    {
      name: 'full_name',
      type: 'string',
      format: null,
      description: "Customer's name as 'First Last', title case, single spaces.",
      isPii: true,
      generated: false,
      required: true,
      allowConcat: true,
    },
    {
      name: 'phone',
      type: 'string',
      format: 'E.164 (+91 followed by 10 digits, first digit 6-9)',
      description: "Customer's mobile number.",
      isPii: true,
      generated: false,
      required: false,
      allowConcat: false,
    },
    {
      name: 'email',
      type: 'string',
      format: 'lower-case email address',
      description: "Customer's email address.",
      isPii: true,
      generated: false,
      required: false,
      allowConcat: false,
    },
    {
      name: 'date_of_birth',
      type: 'date',
      format: 'YYYY-MM-DD',
      description: "Customer's date of birth.",
      isPii: true,
      generated: false,
      required: false,
      allowConcat: false,
    },
    {
      name: 'city',
      type: 'string',
      format: null,
      description: 'City of residence, current official name (e.g. Mumbai, not Bombay).',
      isPii: false,
      generated: false,
      required: false,
      allowConcat: false,
    },
    {
      name: 'pin_code',
      type: 'string',
      format: '6 digits',
      description: 'Indian postal PIN code.',
      isPii: false,
      generated: false,
      required: false,
      allowConcat: false,
    },
    {
      name: 'address',
      type: 'string',
      format: null,
      description: 'Street address line (house number and street).',
      isPii: true,
      generated: false,
      required: false,
      allowConcat: true,
    },
  ],
};
