const vscode = require('vscode');


/**
 * Aligns all cursors in the active text editor by inserting spaces.
 */
function alignCursors() {
  // make sure we have an active text editor
  // NOTE: we use registerCommand instead of registerTextEditorCommand because we
  // need greater control over the TextEditorEdit
  const textEditor = vscode.window.activeTextEditor;
  if (!textEditor) {
    return;
  }
  
  const options = textEditor.options;
  const tab = options.insertSpaces ? 0 : textEditor.options.tabSize;
  // get all the blocks of text that will be aligned from the selections
  const alignBlocks = createAlignBlocksFromSelections(textEditor.document, tab, textEditor.selections);
  if (alignBlocks.length < 2) {
      return;
  }

  const targetStartCol = alignBlocks.reduce((prev, i) => Math.max(prev, i.startCol), 0);
  const targetLength = alignBlocks.reduce((prev, i) => Math.max(prev, i.endCol - i.startCol), 0);

  // calculate where we should insert spaces
  const spaceInserts = createInsertsFromAlignBlocks(alignBlocks, targetStartCol, targetLength, tab);
  if (spaceInserts.length === 0) {
    return;
  }
  
  // NOTE: I'm really not sure how the undo system works. Especially regarding
  // selections.
  // 
  // For example, if you undo and redo a command, the text changes are undone and
  // redone correctly, but the selections are not. The selections do not change
  // when you redo the command. However, if you put a second edit at the end of
  // your command, this fixes the issue (even if the edit does not do anything).
  // 
  // Also, if we do 2 edits and either one or both of the edits create an
  // undo stop, then 2 undos are required to completely undo the command.
  // However, if neither edit creates an undo stop, then 1 undo is required to
  // completely undo the command.
  
  // start the edit
  textEditor.edit(textEditorEdit => {
    // insert all of the spaces
    spaceInserts.forEach(spaceInsert => textEditorEdit.insert(spaceInsert.pos, spaceInsert.str));
  }, {undoStopBefore: false, undoStopAfter: false}) // don't create an undo after (before does not seem to matter)
  .then(() => {
    // select all the aligned blocks
    textEditor.selections = alignBlocks.map(alignBlock => {
      const start = columnToPosition(textEditor.document, tab, alignBlock.line, targetStartCol);
      const end = columnToPosition(textEditor.document, tab, alignBlock.line, targetStartCol + targetLength);
      return new vscode.Selection(start.line, start.character, end.line, end.character);
    });
    
    textEditor.edit(textEditorEdit => {
      // noop
    }, {undoStopBefore: false, undoStopAfter: false});  // don't create an undo stop before (after does not seem to matter)
  }, err => {
    throw err;
  });
}

module.exports = {
  activate(context) {
    // NOTE: we use registerCommand instead of registerTextEditorCommand because we
    // need greater control over the TextEditorEdit
    context.subscriptions.push(vscode.commands.registerCommand('yo1dog.cursor-align.alignCursors', alignCursors));
  },
  
  deactivate() {
  },
  
  alignCursors
};

function positionToColumn(doc, tab, pos) {
  const lineText = doc.lineAt(pos.line).text;
  let col = 0;
  for (let i = 0; i < pos.character; i++) {
      const codePoint = lineText.codePointAt(i);
      if (typeof codePoint !== 'undefined') {
          if (codePoint > 0xffff) {
              ++i;
          }
          col += codePoint === 9 ? tab - (col % tab) : 1;
      }
  }
  return col;
}
function columnToPosition(doc, tab, line, col) {
  const lineText = doc.lineAt(line).text;
  let i = 0;
  for (let currentCol = 0; currentCol < col && i < lineText.length; i++) {
      const codePoint = lineText.codePointAt(i);
      if (typeof codePoint !== 'undefined') {
          if (codePoint > 0xffff) {
              ++i;
          }
          currentCol += codePoint === 9 ? tab - (currentCol % tab) : 1;
      }
  }
  return new vscode.Position(line, i);
}


/**
 * Creates align blocks from the given selections. Align blocks represent
 * the blocks of text that should be aligned.
 * @param {vscode-Selection} selections Selections to create align blocks from.
 * @returns Align blocks.
 */
function createAlignBlocksFromSelections(doc, tab, selections) {
  const alignBlocks = [];
  // create align blocks for each selection
  for (const i of selections) {
      if (i.isSingleLine) {
          // create one block for single-line selections
          alignBlocks.push(createAlignBlock(doc, tab, i.start, i.end));
      }
      else {
          // create two blocks 0-length blocks at the start and end for multi-line selections
          alignBlocks.push(createAlignBlock(doc, tab, i.start, i.start));
          alignBlocks.push(createAlignBlock(doc, tab, i.end, i.end));
      }
  }
  alignBlocks.reduce((prev, i) => {
      const j = prev[i.line];
      prev[i.line] = j ? combineAlignBlocks(j, i) : i;
      return prev;
  }, {});
  return alignBlocks;
}

/**
 * Creates an align block.
 * @param {number} line Line of the align block.
 * @param {number} startChar Starting character of the align block.
 * @param {number} endChar Ending character of the align block.
 * @returns Align block.
 */
function createAlignBlock(doc, tab, start, end) {
  return {
    line: start.line,
    startChar: start.character,
    endChar: end.character,
    startCol: positionToColumn(doc, tab, start),
    endCol: positionToColumn(doc, tab, end),
  };
}
function combineAlignBlocks(a, b) {
  return {
    line: a.line,
    startChar: Math.min(a.startChar, b.startChar),
    endChar: Math.max(a.endChar, b.endChar),
    startCol: Math.min(a.startCol, b.startCol),
    endCol: Math.max(a.endCol, b.endCol),
  };
}

/**
 * Creates space inserts to align the given align blocks. Space Inserts
 * hold spaces and the position to insert them.
 * @param {Object[]} alignBlocks     Align blocks to align.
 * @param {number}   targetStartChar Starting character to align the blocks to.
 * @param {number}   targetLength    Length to align the blocks to.
 */
function createInsertsFromAlignBlocks(alignBlocks, targetStartCol, targetLength, tab) {
  const spaceInserts = [];
  // create space inserts for each align block
  for (const i of alignBlocks) {
    const alignBlockLength = i.endCol - i.startCol;
    const startDist = targetStartCol - i.startCol;
    const endDist = targetLength - alignBlockLength;
    if (startDist > 0) {
      // insert spaces before the align block to align the left side
      spaceInserts.push(createSpaceInsert(i.line, i.startChar, i.startCol, startDist, tab));
    }
    if (endDist > 0) {
      // insert spaces after the align block to align the right side
      spaceInserts.push(createSpaceInsert(i.line, i.endChar, i.endCol, endDist, tab));
    }
  }
  return spaceInserts;
}

/**
 * Creates a space insert.
 * @param {number} line      Line to insert space.
 * @param {number} startChar Character position to insert space at.
 * @param {number} dist      Number of spaces to insert.
 * @returns Space insert.
 */
function createSpaceInsert(line, startChar, startCol, dist, tab) {
  if (tab) {
    const endCol = startCol + dist;
    const firstTab = Math.floor((startCol + tab - 1) / tab);
    const lastTab = Math.floor(endCol / tab);
    return {
      pos: new vscode.Position(line, startChar),
      str: ' '.repeat(firstTab * tab - startCol) + '\t'.repeat(lastTab - firstTab) + ' '.repeat(endCol - lastTab * tab)
    };
  }
  else {
    return {
      pos: new vscode.Position(line, startChar),
      str: ' '.repeat(dist)
    };
  }
}