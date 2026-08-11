@echo off
cd /d "%~dp0"
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:AkiriPoc.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.dll /r:libs\Microsoft.Web.WebView2.Core.dll /r:libs\Microsoft.Web.WebView2.WinForms.dll Poc.cs
if exist AkiriPoc.exe (echo BUILD OK) else (echo BUILD FAILED)
