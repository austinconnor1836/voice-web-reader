Add-Type -AssemblyName System.Drawing
$targetPath = "c:\Users\ac130\Developer\voice-web-reader\assets\screenshot.png"
$fixedPath = "c:\Users\ac130\Developer\voice-web-reader\assets\screenshot_fixed.png"

try {
    $img = [System.Drawing.Image]::FromFile($targetPath)
    Write-Output "Original Size: $($img.Width)x$($img.Height)"

    # Create 1280x800 canvas (PixelFormat 24bppRgb removes alpha)
    $newImg = new-object System.Drawing.Bitmap(1280, 800, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $newImg.SetResolution($img.HorizontalResolution, $img.VerticalResolution)

    $graph = [System.Drawing.Graphics]::FromImage($newImg)
    $graph.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graph.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graph.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Draw white background first to handle any transparency in source
    $graph.Clear([System.Drawing.Color]::White)

    # Calculate aspect ratio to fit (cover or contain? Store usually wants full bleed. Let's stretch fill for now or crop?)
    # Store guidelines say "1280x800". 
    # Let's just draw it to fill the 1280x800 space.
    $graph.DrawImage($img, 0, 0, 1280, 800)
    
    $newImg.Save($fixedPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "Saved fixed image to $fixedPath"
} catch {
    Write-Error "Error processing image: $_"
} finally {
    if ($img) { $img.Dispose() }
    if ($newImg) { $newImg.Dispose() }
    if ($graph) { $graph.Dispose() }
}
