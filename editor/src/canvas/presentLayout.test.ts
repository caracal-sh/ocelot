import { describe, expect, it } from 'vitest';
import { PHONE, presentLayout } from './presentLayout';

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

  it('a phone fits the area whole (never above 1:1); the screen shows through its window and scrolls inside it', () => {
    const area = { width: 1000, height: 700 };
    const box = presentLayout({ width: 375, height: 3000 }, area, 'fit', { x: 0, y: 0 }, true);
    const outerH = Math.round(375 * PHONE.aspect) + PHONE.bezel * 2;
    expect(box.scale).toBeCloseTo((700 - PHONE.margin - PHONE.marginBottom) / outerH, 5);
    expect(box.phone!.height).toBeCloseTo(700 - PHONE.margin - PHONE.marginBottom, 5);
    // The window is the screen's width at the phone's proportions, inset by the bezel; the screen starts at its top-left.
    expect(box.window!.width / box.window!.height).toBeCloseTo(375 / Math.round(375 * PHONE.aspect), 5);
    expect(box.window!.x - box.phone!.x).toBeCloseTo(PHONE.bezel * box.scale, 5);
    expect([box.x, box.y]).toEqual([box.window!.x, box.window!.y]);
    // Scrolling moves the screen up behind the window, never past its end and never sideways.
    expect(box.maxScrollX).toBe(0);
    expect(box.maxScrollY).toBe(Math.round((3000 - Math.round(375 * PHONE.aspect)) * box.scale));
    const end = presentLayout({ width: 375, height: 3000 }, area, 'fit', { x: 50, y: 1e6 }, true);
    expect(end.y).toBeCloseTo(end.window!.y - end.maxScrollY, 5);
    // On a big stage the phone stays at actual size.
    expect(presentLayout({ width: 375, height: 800 }, { width: 3000, height: 3000 }, 'fit', { x: 0, y: 0 }, true).scale).toBe(1);
  });
});
