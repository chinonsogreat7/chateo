import { HttpStatus, Injectable } from '@nestjs/common';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { ApiException } from '../../common/errors/api.exception';

@Injectable()
export class PhoneNumberService {
  normalize(value: string): string {
    const candidate = value.trim();
    if (!candidate.startsWith('+')) {
      throw this.invalidPhoneException();
    }

    const phoneNumber = parsePhoneNumberFromString(candidate);
    if (!phoneNumber?.isValid()) {
      throw this.invalidPhoneException();
    }

    return phoneNumber.number;
  }

  mask(phoneNumber: string): string {
    if (phoneNumber.length <= 6) return phoneNumber;

    const visiblePrefixLength = Math.min(4, phoneNumber.length - 4);
    const visiblePrefix = phoneNumber.slice(0, visiblePrefixLength);
    const visibleSuffix = phoneNumber.slice(-2);
    const hiddenLength = phoneNumber.length - visiblePrefix.length - 2;
    return `${visiblePrefix}${'*'.repeat(hiddenLength)}${visibleSuffix}`;
  }

  private invalidPhoneException(): ApiException {
    return new ApiException(
      HttpStatus.BAD_REQUEST,
      'AUTH_INVALID_PHONE_NUMBER',
      'Enter a valid phone number in E.164 format, including the leading +.',
    );
  }
}
