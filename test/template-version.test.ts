// Tests for src/template-version.ts: the reader of the launcher marker and the markers the shipped launchers carry.
// Run: node --test test/template-version.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LAUNCHER_FILE, readLauncherMarker, TEMPLATE_VERSION } from '../src/template-version.ts';

const ROOT = path.join(import.meta.dirname, '..');
const TEMPLATE = path.join(ROOT, 'templates', LAUNCHER_FILE);
const DEMO_COPY = path.join(ROOT, 'examples', 'demo-portal', LAUNCHER_FILE);

describe('readLauncherMarker', () => {
  test('reads the number from the marker line', () => {
    assert.equal(readLauncherMarker('rem blw-template: 1'), 1);
  });

  test('reads it from text with CRLF line ends', () => {
    assert.equal(readLauncherMarker('@echo off\r\nrem blw-template: 1\r\n'), 1);
  });

  test('reads it from text with LF line ends', () => {
    assert.equal(readLauncherMarker('@echo off\nrem blw-template: 1\n'), 1);
  });

  test('ignores letter case', () => {
    assert.equal(readLauncherMarker('REM BLW-TEMPLATE: 7'), 7);
  });

  test('accepts no blank after the colon', () => {
    assert.equal(readLauncherMarker('rem blw-template:3'), 3);
  });

  test('accepts tabs and trailing blanks', () => {
    assert.equal(readLauncherMarker('rem\tblw-template:\t12  '), 12);
  });

  test('reads it behind a byte order mark on line 1', () => {
    assert.equal(readLauncherMarker('ï»¿@echo off\r\nrem blw-template: 1\r\n'), 1);
    assert.equal(readLauncherMarker('﻿@echo off\r\nrem blw-template: 1\r\n'), 1);
  });

  test('gives undefined when the word after the colon is not a number', () => {
    assert.equal(readLauncherMarker('rem blw-template: abc'), undefined);
  });

  test('gives undefined for more than 6 digits', () => {
    assert.equal(readLauncherMarker('rem blw-template: 1234567'), undefined);
  });

  test('gives undefined when the colon is missing', () => {
    assert.equal(readLauncherMarker('rem blw-template 1'), undefined);
  });

  test('gives undefined when the marker sits inside another command', () => {
    assert.equal(readLauncherMarker('echo rem blw-template: 1'), undefined);
  });

  test('gives undefined for empty text', () => {
    assert.equal(readLauncherMarker(''), undefined);
  });
});

describe('the shipped launchers', () => {
  test('the core holds template version 1', () => {
    assert.equal(TEMPLATE_VERSION, 1);
  });

  test('the template carries the version of the core', () => {
    assert.equal(readLauncherMarker(fs.readFileSync(TEMPLATE, 'latin1')), TEMPLATE_VERSION);
  });

  test('the demo project carries the version of the core', () => {
    assert.equal(readLauncherMarker(fs.readFileSync(DEMO_COPY, 'latin1')), TEMPLATE_VERSION);
  });

  test('the demo project launcher is a byte copy of the template', () => {
    assert.ok(fs.readFileSync(TEMPLATE).equals(fs.readFileSync(DEMO_COPY)));
  });
});
