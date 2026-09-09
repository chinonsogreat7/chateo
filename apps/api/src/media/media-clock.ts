import { Injectable } from '@nestjs/common';

export abstract class MediaClock {
  abstract now(): Date;
}

@Injectable()
export class SystemMediaClock extends MediaClock {
  now(): Date {
    return new Date();
  }
}
