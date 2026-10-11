import { describe, expect, it } from 'vitest';
import { errorStatus } from './errorStatus';
import { ApiError } from './api';

describe('errorStatus', () => {
  it('lee el status de ApiError u objetos con status numérico', () => {
    expect(errorStatus(new ApiError(403, 'Forbidden'))).toBe(403);
    expect(errorStatus({ status: 410 })).toBe(410);
  });

  it('retorna null si no hay status numérico', () => {
    expect(errorStatus(new Error('x'))).toBeNull();
    expect(errorStatus({ status: '403' })).toBeNull();
    expect(errorStatus(null)).toBeNull();
  });
});
