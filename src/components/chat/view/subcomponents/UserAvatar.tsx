import React, { useRef, useState, useEffect } from 'react';

// localStorage 存储键
const AVATAR_STORAGE_KEY = 'user_custom_avatar';

/**
 * 用户头像组件
 * - 从 localStorage 读取自定义头像
 * - 鼠标悬停显示相机图标提示可以更换
 * - 点击触发文件选择，支持 jpg/png/gif/webp 等常见格式
 * - 上传后以 base64 存入 localStorage 持久化
 */
export function UserAvatar() {
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 组件挂载时从 localStorage 加载头像
  useEffect(() => {
    const stored = localStorage.getItem(AVATAR_STORAGE_KEY);
    if (stored) setAvatarSrc(stored);
  }, []);

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target?.result as string;
      localStorage.setItem(AVATAR_STORAGE_KEY, base64);
      setAvatarSrc(base64);
    };
    reader.readAsDataURL(file);
    // 重置 input，允许重复选择同一文件
    e.target.value = '';
  };

  return (
    <div
      className="hidden sm:flex w-8 h-8 rounded-full items-center justify-center text-white text-sm flex-shrink-0 cursor-pointer relative overflow-hidden"
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title="点击更换头像"
    >
      {/* 头像主体：有自定义图片则显示图片，否则显示默认蓝色 U */}
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt="用户头像"
          className="w-full h-full object-cover rounded-full"
        />
      ) : (
        <div className="w-full h-full bg-blue-600 rounded-full flex items-center justify-center">
          U
        </div>
      )}

      {/* 悬停时显示半透明相机图标覆盖层 */}
      {isHovered && (
        <div className="absolute inset-0 bg-black bg-opacity-50 rounded-full flex items-center justify-center">
          <svg
            className="w-4 h-4 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </div>
      )}

      {/* 隐藏的文件 input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
