// 当前用户头像：以 auth context 中的 user.avatar_url 为单一数据源；
// 上传/删除走后端 /api/user/avatar，多账号场景下每个账号有独立头像。
// 兼容多端登录：上传成功后 patch 当前 user.avatar_url 即可，跨设备由登录时返回的 avatar_url 同步。
import { useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../utils/api';

// 将图片文件压缩为指定尺寸的 base64 data URL
function resizeImage(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas error')); return; }

        // 裁剪为正方形居中
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function useUserAvatar() {
  const auth = useAuth() as unknown as {
    user: { avatar_url?: string | null } | null;
    updateUser: (patch: { avatar_url?: string | null }) => void;
  };
  const { user, updateUser } = auth;
  const avatarUrl = user?.avatar_url ?? null;

  const uploadAvatar = useCallback(async (file: File) => {
    const dataUrl = await resizeImage(file, 128);
    const res = await api.user.uploadAvatar(dataUrl);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || 'Upload failed');
    }
    updateUser({ avatar_url: dataUrl });
  }, [updateUser]);

  const removeAvatar = useCallback(async () => {
    const res = await api.user.removeAvatar();
    if (!res.ok) throw new Error('Remove failed');
    updateUser({ avatar_url: null });
  }, [updateUser]);

  return { avatarUrl, uploadAvatar, removeAvatar };
}
