@echo off
cd /d "%~dp0"
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo csc.exe not found ^(need .NET Framework 4.x^)
  exit /b 1
)
"%CSC%" /nologo /target:winexe /out:AkiriBrowser.exe /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:libs\Microsoft.Web.WebView2.Core.dll /r:libs\Microsoft.Web.WebView2.WinForms.dll AkiriHost.cs
if errorlevel 1 (
  echo BUILD FAILED
  exit /b 1
)
copy /y libs\WebView2Loader.dll . >nul
copy /y libs\Microsoft.Web.WebView2.Core.dll . >nul
copy /y libs\Microsoft.Web.WebView2.WinForms.dll . >nul
echo BUILD OK
