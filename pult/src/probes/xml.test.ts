import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../docker/exec';
import { checkXsdSamples, xpathValues } from './xml';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="document">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="number" type="xs:string"/>
        <xs:element name="amount" type="xs:decimal"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const XML = '<document><number>K-1</number><amount>10.5</amount></document>';

let dir = '';
let available = false;

before(async () => {
  available = (await run('xmllint', ['--version'])).code !== 127;
  dir = mkdtempSync(join(tmpdir(), 'kit-xml-test-'));
  writeFileSync(join(dir, 'doc.xsd'), XSD);
  writeFileSync(join(dir, 'doc.xml'), XML);
  writeFileSync(join(dir, 'broken.xsd'), '<xs:schema');
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('xsd.samples', () => {
  it('валидный и невалидный пример', async (t) => {
    if (!available) return t.skip('нет xmllint');
    const result = await checkXsdSamples(join(dir, 'doc.xsd'), [
      { xml: XML, expectValid: true },
      { xml: '<document><number>K-2</number></document>', expectValid: false },
      { xml: '<document><number>K-3</number><amount>много</amount></document>', expectValid: false },
    ]);
    assert.equal(result.allOk, true);
    assert.deepEqual(result.results.map((item) => item.valid), [true, false, false]);
    assert.ok(result.results[1]?.errors.length);
  });

  it('невалидный пример, ожидавшийся валидным, роняет итог', async (t) => {
    if (!available) return t.skip('нет xmllint');
    const result = await checkXsdSamples(join(dir, 'doc.xsd'), [{ xml: '<document/>', expectValid: true }]);
    assert.equal(result.allOk, false);
  });

  it('битая XSD не засчитывает примеры', async (t) => {
    if (!available) return t.skip('нет xmllint');
    const result = await checkXsdSamples(join(dir, 'broken.xsd'), [{ xml: XML, expectValid: false }]);
    assert.equal(result.allOk, false);
    assert.match(result.results[0]?.errors[0] ?? '', /XSD/);
  });
});

describe('xml.xpath', () => {
  it('значения узлов и число совпадений', async (t) => {
    if (!available) return t.skip('нет xmllint');
    const facts = await xpathValues(join(dir, 'doc.xml'), '//number');
    assert.equal(facts.count, 1);
    assert.deepEqual(facts.values, ['K-1']);
    const none = await xpathValues(join(dir, 'doc.xml'), '//missing');
    assert.equal(none.count, 0);
  });
});
