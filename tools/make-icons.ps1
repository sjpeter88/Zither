# Draws the app icons (PNG for the web app, ICO for the Windows shell).
#   pwsh tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'web\icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$size, [string]$path, [double]$pad) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $full = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $full, ([System.Drawing.Color]::FromArgb(255, 44, 30, 20)), ([System.Drawing.Color]::FromArgb(255, 13, 10, 8)), 90
  $g.FillRectangle($bg, $full)
  # spruce top
  $m = [int]($size * $pad); $w = $size - 2 * $m
  $body = New-Object System.Drawing.Rectangle $m, $m, $w, $w
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = [int]($w * 0.2)
  $path2.AddArc($body.X, $body.Y, $r, $r, 180, 90); $path2.AddArc($body.Right - $r, $body.Y, $r, $r, 270, 90)
  $path2.AddArc($body.Right - $r, $body.Bottom - $r, $r, $r, 0, 90); $path2.AddArc($body.X, $body.Bottom - $r, $r, $r, 90, 90); $path2.CloseFigure()
  $wood = New-Object System.Drawing.Drawing2D.LinearGradientBrush $body, ([System.Drawing.Color]::FromArgb(255, 238, 186, 104)), ([System.Drawing.Color]::FromArgb(255, 150, 86, 34)), 55
  $g.FillPath($wood, $path2)
  $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 60, 30, 12)), ([single]($size * 0.018))
  $g.DrawPath($edge, $path2)
  # sound hole with rosette
  $cx = $size * 0.5; $cy = $size * 0.5; $hr = $w * 0.2
  $ring = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 245, 228, 190)), ([single]($size * 0.012))
  $g.DrawEllipse($ring, [single]($cx - $hr * 1.28), [single]($cy - $hr * 1.28), [single]($hr * 2.56), [single]($hr * 2.56))
  $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 18, 11, 7))
  $g.FillEllipse($dark, [single]($cx - $hr), [single]($cy - $hr), [single]($hr * 2), [single]($hr * 2))
  # strings
  $g.SetClip($path2)
  for ($i = 0; $i -lt 9; $i++) {
    $y = $m + $w * (0.14 + 0.09 * $i)
    $col = if ($i % 4 -eq 1) { [System.Drawing.Color]::FromArgb(255, 196, 46, 44) } else { [System.Drawing.Color]::FromArgb(245, 250, 246, 236) }
    $pen = New-Object System.Drawing.Pen $col, ([single]([Math]::Max(1, $size * (0.008 + 0.0012 * $i))))
    $g.DrawLine($pen, [single]$m, [single]$y, [single]($m + $w), [single]$y)
  }
  $g.ResetClip()
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Icon 32 (Join-Path $out 'icon-32.png') 0.06
New-Icon 180 (Join-Path $out 'apple-touch-icon.png') 0.1
New-Icon 192 (Join-Path $out 'icon-192.png') 0.1
New-Icon 512 (Join-Path $out 'icon-512.png') 0.1
New-Icon 512 (Join-Path $out 'icon-maskable-512.png') 0.2
New-Icon 256 (Join-Path $out 'icon-256.png') 0.08

# ICO container holding the 256px PNG (for the .exe)
$png = [System.IO.File]::ReadAllBytes((Join-Path $out 'icon-256.png'))
$ico = Join-Path $root 'shell\app.ico'
$fs = [System.IO.File]::Create($ico)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)
$bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$png.Length); $bw.Write([uint32]22)
$bw.Write($png); $bw.Close(); $fs.Close()
Remove-Item (Join-Path $out 'icon-256.png')
Get-ChildItem $out, $ico | Select-Object Name, Length
