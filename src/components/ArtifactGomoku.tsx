import React, { useState } from 'react';
import { Grid3X3, RotateCcw, Award, Sparkles, MessageCircle } from 'lucide-react';
import { GomokuPiece, AppSettings } from '../types';

interface ArtifactGomokuProps {
  settings: AppSettings;
}

const BOARD_SIZE = 15;

export const ArtifactGomoku: React.FC<ArtifactGomokuProps> = ({ settings }) => {
  const [board, setBoard] = useState<GomokuPiece[][]>(() =>
    Array(BOARD_SIZE)
      .fill(null)
      .map(() => Array(BOARD_SIZE).fill(null))
  );
  const [currentTurn, setCurrentTurn] = useState<'black' | 'white'>('black');
  const [winner, setWinner] = useState<'black' | 'white' | 'draw' | null>(null);
  const [aiComment, setAiComment] = useState<string>('黑棋先行，请下第一手吧～我可不会手下留情哦！');
  const [lastMove, setLastMove] = useState<[number, number] | null>(null);

  // 检查是否五子连珠
  const checkWin = (grid: GomokuPiece[][], r: number, c: number, piece: GomokuPiece): boolean => {
    if (!piece) return false;
    const directions = [
      [0, 1],  // 水平
      [1, 0],  // 垂直
      [1, 1],  // 顺斜
      [1, -1], // 反斜
    ];

    for (const [dr, dc] of directions) {
      let count = 1;
      // 正向
      let nr = r + dr;
      let nc = c + dc;
      while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && grid[nr][nc] === piece) {
        count++;
        nr += dr;
        nc += dc;
      }
      // 反向
      nr = r - dr;
      nc = c - dc;
      while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && grid[nr][nc] === piece) {
        count++;
        nr -= dr;
        nc -= dc;
      }
      if (count >= 5) return true;
    }
    return false;
  };

  // 玩家落子（执黑）
  const handleCellClick = (r: number, c: number) => {
    if (board[r][c] || winner || currentTurn !== 'black') return;

    const newBoard = board.map((row) => [...row]);
    newBoard[r][c] = 'black';
    setBoard(newBoard);
    setLastMove([r, c]);

    if (checkWin(newBoard, r, c, 'black')) {
      setWinner('black');
      setAiComment('厉害呀！这手太妙了，我甘拜下风！🎉');
      return;
    }

    setCurrentTurn('white');
    setAiComment('落子很有想法呢，容我想想怎么应对...');

    // 延迟 500ms AI 落子
    setTimeout(() => {
      makeAiMove(newBoard);
    }, 500);
  };

  // AI 智能落子（启发式权值搜索）
  const makeAiMove = (grid: GomokuPiece[][]) => {
    let bestScore = -Infinity;
    let bestMove: [number, number] | null = null;

    // 启发式打分
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (!grid[r][c]) {
          // 只搜索附近有子的点提升性能
          let hasNeighbor = false;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const nr = r + dr;
              const nc = c + dc;
              if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && grid[nr][nc]) {
                hasNeighbor = true;
                break;
              }
            }
            if (hasNeighbor) break;
          }

          if (!hasNeighbor && (r !== 7 || c !== 7)) continue;

          // 计算进攻分与防守分
          grid[r][c] = 'white';
          const attackScore = evaluatePoint(grid, r, c, 'white');
          grid[r][c] = 'black';
          const defenseScore = evaluatePoint(grid, r, c, 'black');
          grid[r][c] = null;

          const totalScore = attackScore * 1.1 + defenseScore;
          if (totalScore > bestScore) {
            bestScore = totalScore;
            bestMove = [r, c];
          }
        }
      }
    }

    if (!bestMove) {
      bestMove = [7, 7];
    }

    const [aiR, aiC] = bestMove;
    const nextBoard = grid.map((row) => [...row]);
    nextBoard[aiR][aiC] = 'white';
    setBoard(nextBoard);
    setLastMove([aiR, aiC]);

    if (checkWin(nextBoard, aiR, aiC, 'white')) {
      setWinner('white');
      setAiComment('承让啦！这局我侥幸得胜，要不再来一局？✨');
      return;
    }

    setCurrentTurn('black');
    const aiComments = [
      '这手我防守一下，看你下一步怎么走～',
      '攻势挺凌厉呀，我得严阵以待了！',
      '感觉这里的争夺很激烈，轮到你啦。',
      '落定白子！到你的回合咯。',
    ];
    setAiComment(aiComments[Math.floor(Math.random() * aiComments.length)]);
  };

  // 单点价值评估
  const evaluatePoint = (grid: GomokuPiece[][], r: number, c: number, piece: GomokuPiece): number => {
    let score = 0;
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of directions) {
      let count = 1;
      let openEnds = 0;
      let nr = r + dr;
      let nc = c + dc;
      while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && grid[nr][nc] === piece) {
        count++;
        nr += dr;
        nc += dc;
      }
      if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && !grid[nr][nc]) openEnds++;

      nr = r - dr;
      nc = c - dc;
      while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && grid[nr][nc] === piece) {
        count++;
        nr -= dr;
        nc -= dc;
      }
      if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && !grid[nr][nc]) openEnds++;

      if (count >= 5) score += 100000;
      else if (count === 4 && openEnds === 2) score += 10000;
      else if (count === 4 && openEnds === 1) score += 1000;
      else if (count === 3 && openEnds === 2) score += 1000;
      else if (count === 3 && openEnds === 1) score += 100;
      else if (count === 2 && openEnds === 2) score += 50;
    }
    return score;
  };

  const handleReset = () => {
    setBoard(
      Array(BOARD_SIZE)
        .fill(null)
        .map(() => Array(BOARD_SIZE).fill(null))
    );
    setCurrentTurn('black');
    setWinner(null);
    setLastMove(null);
    setAiComment('新棋局已摆好，黑先走～');
  };

  return (
    <div className="flex flex-col h-[460px] bg-[#fcfaf5]/95 backdrop-blur-md border border-[#e5dec9] rounded-2xl shadow-float overflow-hidden">
      {/* 顶部状态与控制 */}
      <div className="px-4 py-2 border-b border-[#ece6d5] bg-[#f9f6ed] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Grid3X3 size={16} className="text-[#a8681a]" />
          <h3 className="text-sm font-semibold text-[#23293a]">摸鱼五子棋</h3>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#f2ecdc] text-[#8a5410]">
            你(黑) vs {settings.personaName || 'Ambi'}(白)
          </span>
        </div>

        <button
          onClick={handleReset}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-[#efeadd] hover:bg-[#e2d8c3] text-[#8a5410] transition-colors"
          title="重新开局"
        >
          <RotateCcw size={12} />
          <span>重新开局</span>
        </button>
      </div>

      {/* 伴侣吐槽与心理战气泡 */}
      <div className="px-3 py-1.5 bg-[#f5f1e6] border-b border-[#ece6d5] flex items-center gap-2 text-xs text-[#8a5410]">
        <MessageCircle size={13} className="shrink-0" />
        <span className="truncate">{aiComment}</span>
      </div>

      {/* 棋盘主体（仿木质纹理棋盘） */}
      <div className="flex-1 overflow-hidden p-3 flex items-center justify-center bg-[#e8d7b8]">
        <div className="grid grid-cols-15 gap-0 p-2 bg-[#d8be92] border-2 border-[#b59b6c] rounded-lg shadow-inner max-w-[340px] max-h-[340px] w-full aspect-square">
          {board.map((row, r) =>
            row.map((cell, c) => {
              const isLast = lastMove && lastMove[0] === r && lastMove[1] === c;
              return (
                <button
                  key={`${r}-${c}`}
                  onClick={() => handleCellClick(r, c)}
                  disabled={!!cell || !!winner || currentTurn !== 'black'}
                  className="relative flex items-center justify-center w-full h-full border border-[#c4aa7b]/60 hover:bg-black/5 transition-colors cursor-pointer"
                >
                  {/* 棋子展示 */}
                  {cell === 'black' && (
                    <div
                      className={`w-[82%] h-[82%] rounded-full bg-gradient-to-br from-stone-700 to-black shadow-md ${
                        isLast ? 'ring-2 ring-amber-400' : ''
                      }`}
                    />
                  )}
                  {cell === 'white' && (
                    <div
                      className={`w-[82%] h-[82%] rounded-full bg-gradient-to-br from-white to-stone-200 border border-stone-300 shadow-md ${
                        isLast ? 'ring-2 ring-amber-500' : ''
                      }`}
                    />
                  )}
                  {/* 天元与星位点 */}
                  {(r === 3 || r === 7 || r === 11) && (c === 3 || c === 7 || c === 11) && !cell && (
                    <div className="w-1.5 h-1.5 rounded-full bg-[#8c744c]" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 胜负横幅 */}
      {winner && (
        <div className="p-2 bg-[#efeadd] border-t border-[#ded5be] text-center text-xs font-semibold text-[#8a5410] flex items-center justify-center gap-1.5">
          <Award size={14} className="text-amber-600" />
          <span>
            {winner === 'black' ? '恭喜你获得胜利！🎉' : `${settings.personaName || 'Ambi'} 胜出～`}
          </span>
        </div>
      )}
    </div>
  );
};
