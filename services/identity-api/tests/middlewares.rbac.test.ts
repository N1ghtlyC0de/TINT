import { describe, it, expect, vi } from 'vitest';
import { requireRole } from '../src/middlewares/auth.js';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('requireRole middleware', () => {
  it('responde 401 si req.user no está definido', () => {
    const req: any = {};
    const res = mockRes();
    const next = vi.fn();

    requireRole(['public_host', 'private_host'])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('responde 403 Forbidden si el rol del usuario no tiene permisos', () => {
    const req: any = {
      user: {
        id: 'u-1',
        providerSub: 'sub-1',
        role: 'participant',
      },
    };
    const res = mockRes();
    const next = vi.fn();

    requireRole(['public_host', 'private_host'])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: Insufficient permissions' });
    expect(next).not.toHaveBeenCalled();
  });

  it('llama next() si el rol está permitido', () => {
    const req: any = {
      user: {
        id: 'u-1',
        providerSub: 'sub-1',
        role: 'public_host',
      },
    };
    const res = mockRes();
    const next = vi.fn();

    requireRole(['public_host', 'private_host'])(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

