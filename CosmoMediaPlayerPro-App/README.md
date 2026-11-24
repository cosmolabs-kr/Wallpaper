# Cosmo Media Player Pro – App Edition

A media player wallpaper for [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/) with **working media buttons**.

![Preview](preview.gif)

The Workshop version of Cosmo Media Player Pro is a *web* wallpaper, and Wallpaper Engine does not let web wallpapers control playback. This edition is an *application* wallpaper, which can – but Wallpaper Engine does not allow application wallpapers on the Workshop, so it is published here instead.

## What it adds over the Workshop version

- **Play / pause, next and previous buttons** that control the current player (Apple Music, Spotify, browsers – anything that shows up in the Windows media overlay)
- **Real audio capture** from your output device: true frequency bands, plus the device name, sample rate and bit depth in the analyzer panel
- **Settings panel inside the wallpaper** (gear button on the card): colors, your own background image, size and position, analyzer, lyrics, clock (position, size, font, glass box), and language (Auto / English / 한국어 / 中文)
- **Update notice**: when a newer release is out, the gear button gets a red dot and the settings panel shows a button that opens the download page

Everything else is the same: album-color background, glass card with vinyl deck, analyzer panel (stereo spectrum, spectrogram, loudness, tempo with beat position and confidence, tonal balance), karaoke-style synced lyrics, clock.

## Requirements

- Windows 10 or 11 (64-bit)
- Wallpaper Engine
- Microsoft Edge WebView2 Runtime – already part of Windows 11 and of most Windows 10 installs. If the wallpaper shows a "could not start" message, install it from <https://developer.microsoft.com/microsoft-edge/webview2/>

## Install

1. Download `CosmoMediaPlayerPro-App.zip` from the [latest release](https://github.com/cosmolabs-kr/Wallpaper/releases/latest).
2. Right-click the zip → **Properties** → tick **Unblock** → OK. (Windows marks downloaded files; unblocking first avoids warnings.)
3. Extract it to a folder that will stay where it is, for example `Documents\Wallpapers\CosmoMediaPlayerPro_App`.
4. In Wallpaper Engine, click **Open Wallpaper → Open from File** (bottom left) and pick `project.json` from that folder – or simply drag `project.json` onto the Wallpaper Engine window.

To update, close the wallpaper in Wallpaper Engine, replace the folder's contents with the new release, and open it again. Your settings are kept. The wallpaper tells you when a new release is out (see "Good to know"); it never downloads or installs anything by itself.

## Using it

- Click the buttons on the card right on the desktop.
- The **gear** button opens the settings panel. Settings are saved automatically.
- The previous-track button is greyed out whenever the player itself has no previous track (for example Apple Music stations).
- The wallpaper follows Wallpaper Engine's pause rules (full-screen applications and so on).

## Good to know

This is a program, not a web page, and it does a few things you should know about before running it:

- It **watches the mouse position and left clicks** while the pointer is over the bare desktop. A wallpaper sits underneath the desktop icons and receives no mouse input from Windows, so this is the only way buttons on a wallpaper can work. Nothing is recorded or sent anywhere.
- It **listens to what your default output device is playing** (loopback capture) to draw the spectrum. The audio is analysed in memory only.
- It **starts a second copy of itself** next to the one Wallpaper Engine starts. Wallpaper Engine takes over the windows of the program it launches, which breaks the WebView2 component that draws the wallpaper; the second copy does the drawing and closes together with the wallpaper.
- It makes two kinds of network request, and both can be turned off in the settings:
  - **Lyrics lookup**: track title and artist are sent to [lrclib.net](https://lrclib.net) (option *Karaoke lyrics*).
  - **Update check**: it asks github.com for this repository's latest release number at start and about once a day (option *Check for updates*). Nothing about you or your music is sent.

Some antivirus products are suspicious of unsigned programs that do the first and third of these. The full source is in this repository if you prefer to check or build it yourself.

## Build from source

Requires the .NET SDK (any recent version; the project targets .NET Framework 4.8).

```
dotnet build CosmoMediaPlayerPro-App/src -c Release
```

Then put together the wallpaper folder: the contents of `src\bin\Release\net48`, the `web` folder, `project.json` and `preview.gif`.

## Troubleshooting

- **Black screen with a "could not start" message** – install the WebView2 Runtime (see Requirements).
- **Nothing happens / wallpaper does not appear** – Wallpaper Engine may be paused because another window is in front; show the desktop. A log is written to `%TEMP%\CosmoPlayer.log`.
- **Buttons do not react** – another window or a desktop icon is covering them, or the player does not support that command.

## Third-party components

- [NAudio](https://github.com/naudio/NAudio) – MIT License
- [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) – Microsoft Software License
- Lyrics by [LRCLIB](https://lrclib.net)
