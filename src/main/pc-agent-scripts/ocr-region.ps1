# ocr-region.ps1
# 100% Offline Windows Runtime OCR fallback for MARK PC Automation
# Zero Vision Tokens: Converts screen region to JSON text coordinates (~300-500 tokens)

$ErrorActionPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Win32 API to get foreground window title & bounding rect
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
Add-Type -TypeDefinition $code -Language CSharp

$hwnd = [Win32]::GetForegroundWindow()
$titleBuilder = New-Object System.Text.StringBuilder 512
[Win32]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
$windowTitle = $titleBuilder.ToString()

$rect = New-Object RECT
[Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

if ($width -le 0 -or $height -le 0) {
    # Fallback to primary screen bounds if window rect is invalid
    $width = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $height = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
    $rect.Left = 0
    $rect.Top = 0
}

# Capture screen region
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$tempPath = [System.IO.Path]::Combine($env:TEMP, "mark_ocr_temp_$([Guid]::NewGuid().ToString('N')).png")
$bmp.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()

# Run WinRT OCR
$detectedText = @()
try {
    $ocrEngine = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]::TryCreateFromUserProfileLanguages()
    if ($ocrEngine) {
        $file = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]::GetFileFromPathAsync($tempPath).GetAwaiter().GetResult()
        $stream = $file.OpenAsync([Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]::Read).GetAwaiter().GetResult()
        $decoder = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]::CreateAsync($stream).GetAwaiter().GetResult()
        $bitmap = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult()

        $result = $ocrEngine.RecognizeAsync($bitmap).GetAwaiter().GetResult()

        $idCounter = 1
        foreach ($line in $result.Lines) {
            $lineText = $line.Text
            if ([string]::IsNullOrWhiteSpace($lineText)) { continue }
            
            # Compute bounding box of entire line in screen coordinates
            $firstWord = $line.Words[0]
            $lastWord = $line.Words[$line.Words.Count - 1]

            $lineX = $rect.Left + [int]$firstWord.BoundingRect.X
            $lineY = $rect.Top + [int]$firstWord.BoundingRect.Y
            $lineW = [int]($lastWord.BoundingRect.X + $lastWord.BoundingRect.Width - $firstWord.BoundingRect.X)
            $lineH = [int]$firstWord.BoundingRect.Height

            $detectedText += @{
                id = $idCounter
                text = $lineText
                rect = @($lineX, $lineY, $lineW, $lineH)
            }
            $idCounter++
            if ($idCounter -gt 60) { break }
        }
    }
} catch {
    # If OCR fails, return empty detected_text
} finally {
    if (Test-Path $tempPath) {
        Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
    }
}

$output = @{
    window = $windowTitle
    method = "ocr"
    elements = $detectedText
    element_count = $detectedText.Count
}

$json = $output | ConvertTo-Json -Depth 5 -Compress
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $json
