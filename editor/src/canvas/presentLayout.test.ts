import { describe, expect, it } from 'vitest';
import { presentLayout } from './presentLayout';

describe('present layout', () => {
  it('scales a wide screen to the width of the area and centers it vertically when it fits', () => {
    const box = presentLayout({ width: 1440, height: 900 }, { width: 720, height: 600 }, 'fit', { x: 0, y: 0 });
    expect(box.scale).toBe(0.5);
    expect(box.x).toBe(0);
    expect(box.y).toBe((600 - 450) / 2);
    expect(box.maxScrollY).toBe(0);
  });

  it('never scales above 1:1 and centers a narrow screen horizontally', () => {
    const box = presentLayout({ width: 390, height: 600 }, { width: 1000, height: 800 }, 'fit', { x: 0, y: 0 });
    expect(box.scale).toBe(1);
    expect(box.x).toBe(305);
    expect(box.y).toBe(100);
  });

  it('scrolls vertically when the screen is taller than the area, clamped to its extent', () => {
    const tall = { width: 375, height: 2000 };
    const area = { width: 375, height: 800 };
    expect(presentLayout(tall, area, 'fit', { x: 0, y: 0 })).toMatchObject({ scale: 1, y: 0, maxScrollY: 1200 });
    expect(presentLayout(tall, area, 'fit', { x: 0, y: 500 }).y).toBe(-500);
    expect(presentLayout(tall, area, 'fit', { x: 0, y: 99999 }).y).toBe(-1200);
    expect(presentLayout(tall, area, 'fit', { x: 0, y: -50 }).y).toBe(0);
  });

  it('100% keeps the actual size and scrolls sideways too', () => {
    const box = presentLayout({ width: 1440, height: 900 }, { width: 720, height: 600 }, 'actual', { x: 100, y: 50 });
    expect(box).toMatchObject({ scale: 1, x: -100, y: -50, maxScrollX: 720, maxScrollY: 300 });
  });
});
