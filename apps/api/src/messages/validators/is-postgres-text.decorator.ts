import {
  ValidateBy,
  type ValidationOptions,
  buildMessage,
} from 'class-validator';

export const IS_POSTGRES_TEXT = 'isPostgresText';

export function IsPostgresText(
  maximumCodePoints: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: IS_POSTGRES_TEXT,
      constraints: [maximumCodePoints],
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' &&
          !value.includes('\u0000') &&
          Array.from(value).length <= maximumCodePoints,
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must not contain null characters and must be shorter than or equal to $constraint1 Unicode code points`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
