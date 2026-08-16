// MediaSphere - 텍스트 패턴 비트맵 배치
//
// 문자열을 textPatternFont의 도트매트릭스 글리프로 그리드(gridCols x totalRows) 좌표계에
// 가운데 정렬해서 배치한다. 서버가 이 결과(grid)를 manifest의 각 폰 row/col과 대조해서
// 전경(글자)/배경을 판정하고 폰별로 다른 색을 개별 발행하는 데 쓴다.
'use strict';

const { CHAR_HEIGHT, getGlyph } = require('./textPatternFont');

const CHAR_GAP = 1; // 글자 사이 빈 칸 수

// 반환: { grid, numChars }
//   grid[row][col] = 그 칸이 속한 글자 인덱스(0부터, 전경) 또는 -1(배경/빈 칸)
//   numChars = 글자 수(스페이스 포함) - 글자별 페이드인 시차 계산에 쓰인다
function computeTextPatternGrid(text, gridCols, totalRows) {
  const chars = Array.from(text.length > 0 ? text : ' ');
  const glyphs = chars.map((c) => getGlyph(c));

  let totalWidth = 0;
  const colStarts = [];
  glyphs.forEach((glyph, i) => {
    colStarts.push(totalWidth);
    totalWidth += glyph[0].length;
    if (i < glyphs.length - 1) totalWidth += CHAR_GAP;
  });

  // 그리드보다 넓으면 잘려서 발행된다(에러로 막지 않음) - 짧은 문구 기준 기능이라
  // 너무 긴 입력은 일단 가운데 기준으로 잘리는 정도로 허용한다.
  const colOffset = Math.floor((gridCols - totalWidth) / 2);
  const rowOffset = Math.floor((totalRows - CHAR_HEIGHT) / 2);

  const grid = Array.from({ length: totalRows }, () => new Array(gridCols).fill(-1));

  glyphs.forEach((glyph, charIndex) => {
    const glyphWidth = glyph[0].length;
    for (let gr = 0; gr < CHAR_HEIGHT; gr += 1) {
      const row = rowOffset + gr;
      if (row < 0 || row >= totalRows) continue;
      for (let gc = 0; gc < glyphWidth; gc += 1) {
        if (glyph[gr][gc] !== '1') continue;
        const col = colOffset + colStarts[charIndex] + gc;
        if (col < 0 || col >= gridCols) continue;
        grid[row][col] = charIndex;
      }
    }
  });

  return { grid, numChars: chars.length };
}

module.exports = { computeTextPatternGrid };
