param(
    [string]$SourceRoot = (Join-Path $PSScriptRoot '..\theme-sources'),
    [string]$OutputRoot = (Join-Path $PSScriptRoot '..\public\themes')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$themes = @('sakura', 'sky', 'star')
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' } |
    Select-Object -First 1

function New-HighQualityGraphics([System.Drawing.Bitmap]$Bitmap) {
    $graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    return $graphics
}

function Save-PngByHeight([string]$InputPath, [string]$OutputPath, [int]$Height) {
    $source = [System.Drawing.Bitmap]::FromFile($InputPath)
    try {
        $width = [Math]::Max(1, [int][Math]::Round($source.Width * $Height / $source.Height))
        $bitmap = New-Object System.Drawing.Bitmap($width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = New-HighQualityGraphics $bitmap
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $width, $Height))
            } finally {
                $graphics.Dispose()
            }
            $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $source.Dispose()
    }
}

function Save-PngCrop([string]$InputPath, [string]$OutputPath, [System.Drawing.Rectangle]$Crop, [int]$Size) {
    $source = [System.Drawing.Bitmap]::FromFile($InputPath)
    try {
        if ($Crop.Right -gt $source.Width -or $Crop.Bottom -gt $source.Height) {
            throw "Crop exceeds source bounds: $InputPath"
        }
        $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = New-HighQualityGraphics $bitmap
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.DrawImage(
                    $source,
                    [System.Drawing.Rectangle]::new(0, 0, $Size, $Size),
                    $Crop,
                    [System.Drawing.GraphicsUnit]::Pixel
                )
            } finally {
                $graphics.Dispose()
            }
            $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $source.Dispose()
    }
}

function Save-Jpeg([string]$InputPath, [string]$OutputPath, [int]$Width, [int]$Height, [long]$Quality) {
    $source = [System.Drawing.Bitmap]::FromFile($InputPath)
    try {
        $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
            $graphics = New-HighQualityGraphics $bitmap
            try {
                $graphics.Clear([System.Drawing.Color]::White)
                $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $Width, $Height))
            } finally {
                $graphics.Dispose()
            }
            $qualityEncoder = [System.Drawing.Imaging.Encoder]::Quality
            $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
            try {
                $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($qualityEncoder, $Quality)
                $bitmap.Save($OutputPath, $jpegCodec, $parameters)
            } finally {
                $parameters.Dispose()
            }
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $source.Dispose()
    }
}

foreach ($theme in $themes) {
    $sourceDir = Join-Path $SourceRoot $theme
    $outputDir = Join-Path $OutputRoot $theme
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

    $character = Join-Path $sourceDir 'character.png'
    Save-PngByHeight $character (Join-Path $outputDir 'character-hero.png') 290
    Save-PngByHeight $character (Join-Path $outputDir 'character-hero@2x.png') 580
    # Appearance cards show the complete transparent character artwork. Keep this
    # separate from the tightly cropped sidebar avatar.
    Save-PngByHeight $character (Join-Path $outputDir 'character-card.png') 192
    Save-PngCrop $character (Join-Path $outputDir 'character-avatar.png') ([System.Drawing.Rectangle]::new(210, 0, 900, 900)) 40
    Save-PngCrop $character (Join-Path $outputDir 'character-avatar@2x.png') ([System.Drawing.Rectangle]::new(210, 0, 900, 900)) 80

    foreach ($mode in @('light', 'dark')) {
        $scene = Join-Path $sourceDir "scene-$mode.png"
        Save-Jpeg $scene (Join-Path $outputDir "scene-$mode-1280.jpg") 1280 427 80
        Save-Jpeg $scene (Join-Path $outputDir "scene-$mode-1920.jpg") 1920 640 82
    }
}

Write-Host "Generated responsive theme assets in $OutputRoot"
