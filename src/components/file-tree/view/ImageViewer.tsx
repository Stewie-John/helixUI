import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, X, ZoomIn, ZoomOut, RotateCw } from 'lucide-react';
import { Button } from '../../ui/button';
import { authenticatedFetch } from '../../../utils/api';
import type { FileTreeImageSelection } from '../types/types';

type ImageViewerProps = {
  file: FileTreeImageSelection;
  onClose: () => void;
};

export default function ImageViewer({ file, onClose }: ImageViewerProps) {
  const { t } = useTranslation('codeEditor');
  const imagePath = `/api/projects/${file.projectName}/files/content?path=${encodeURIComponent(file.path)}`;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();

    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        setImageUrl(null);

        const response = await authenticatedFetch(imagePath, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (loadError: unknown) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return;
        }
        console.error('Error loading image:', loadError);
        setError('Unable to load image');
      } finally {
        setLoading(false);
      }
    };

    loadImage();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [imagePath]);

  // 下载图片
  const handleDownload = useCallback(() => {
    if (!imageUrl) return;
    const a = document.createElement('a');
    a.href = imageUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [imageUrl, file.name]);

  // 键盘快捷键：Esc 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl max-h-[90vh] w-full mx-4 overflow-hidden flex flex-col">
        {/* 顶部栏：文件名 + 操作按钮 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">{file.name}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{file.path}</p>
          </div>

          <div className="flex items-center gap-0.5 ml-3 shrink-0">
            {/* 缩小 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
              className="h-8 w-8 p-0"
              title={t('imageViewer.zoomOut')}
              disabled={zoom <= 0.25}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>

            {/* 缩放比例 */}
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="px-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white tabular-nums min-w-[3rem] text-center"
              title={t('imageViewer.resetZoom')}
            >
              {Math.round(zoom * 100)}%
            </button>

            {/* 放大 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
              className="h-8 w-8 p-0"
              title={t('imageViewer.zoomIn')}
              disabled={zoom >= 4}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>

            {/* 分隔线 */}
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-1" />

            {/* 旋转 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              className="h-8 w-8 p-0"
              title={t('imageViewer.rotate')}
            >
              <RotateCw className="h-4 w-4" />
            </Button>

            {/* 下载 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              className="h-8 w-8 p-0"
              title={t('imageViewer.download')}
              disabled={!imageUrl}
            >
              <Download className="h-4 w-4" />
            </Button>

            {/* 分隔线 */}
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-1" />

            {/* 关闭 */}
            <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0" title={t('imageViewer.close')}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 图片内容区 */}
        <div className="flex-1 overflow-auto flex justify-center items-center bg-gray-50 dark:bg-gray-900 min-h-[400px] p-4">
          {loading && (
            <div className="text-center text-gray-500 dark:text-gray-400">
              <div className="inline-block w-6 h-6 border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin mb-2" />
              <p className="text-sm">{t('imageViewer.loading')}</p>
            </div>
          )}
          {!loading && imageUrl && (
            <img
              src={imageUrl}
              alt={file.name}
              className="max-w-full max-h-[70vh] object-contain rounded shadow-md transition-transform duration-200"
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transformOrigin: 'center center',
              }}
              draggable={false}
            />
          )}
          {!loading && !imageUrl && (
            <div className="text-center text-gray-500 dark:text-gray-400">
              <p>{error || 'Unable to load image'}</p>
              <p className="text-sm mt-2 break-all">{file.path}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
