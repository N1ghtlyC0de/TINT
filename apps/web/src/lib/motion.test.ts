import { ease, spring, fadeUp, fadeBlur, stagger, pop, scaleIn } from './motion';

describe('motion presets', () => {
  it('usa una curva de salida suave y un spring amortiguado', () => {
    expect(ease).toEqual([0.22, 1, 0.36, 1]);
    expect(spring).toMatchObject({ type: 'spring', stiffness: 380, damping: 30 });
  });

  it('las variantes parten ocultas y terminan visibles', () => {
    for (const v of [fadeUp, fadeBlur, pop, scaleIn]) {
      expect(v.hidden).toMatchObject({ opacity: 0 });
      expect(v.show).toMatchObject({ opacity: 1 });
    }
    expect(fadeBlur.hidden).toMatchObject({ filter: 'blur(6px)' });
    expect(fadeBlur.show).toMatchObject({ filter: 'blur(0px)' });
  });

  it('stagger escalona a los hijos con el retraso indicado', () => {
    expect(stagger().show).toMatchObject({ transition: { staggerChildren: 0.05 } });
    expect(stagger(0.1, 0.2).show).toMatchObject({ transition: { staggerChildren: 0.1, delayChildren: 0.2 } });
  });
});
