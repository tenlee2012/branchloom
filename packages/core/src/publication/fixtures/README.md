仅供测试：两个 PDF 都是 pypdf 生成的 200 × 300 pt 空白页，使用标准 PDF 加密。encrypted-password 的用户密码为 fixture-password；encrypted-empty 的用户密码为空；所有者密码均为 fixture-owner。用于验证两类加密文件均被拒绝，不含用户资料。

`orientation-6.jpg` 是 Pillow 生成的 60 × 90 像素纯色图片，EXIF Orientation 为 6，排版后应为 90 × 60；用于照片旋转与 JPEG 编码回归，不含用户照片或定位资料。
