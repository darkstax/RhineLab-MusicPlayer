// WASAPI 端点能力探测：设备矩阵、独占支持格式、period 参数。
// 数据用于 docs/AUDIO-ENGINE.md §23 硬件环境实测 与 §19 测试矩阵。
// 运行：pwsh -File run.ps1（Windows，.NET 10 SDK + NAudio 3.x）
using NAudio.CoreAudioApi;
using NAudio.Wave;

Console.OutputEncoding = System.Text.Encoding.UTF8;
using var e = new MMDeviceEnumerator();
var def = e.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
Console.WriteLine($"默认设备: {def.FriendlyName}\n  ID={def.ID}");

int[] rates = { 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000 };

foreach (var d in e.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
{
    Console.WriteLine($"\n===== {d.FriendlyName} {(d.ID == def.ID ? "[DEFAULT]" : "")} =====");
    Console.WriteLine($"  InstanceId: {d.InstanceId}");
    using var ac = d.CreateAudioClient();
    Console.WriteLine($"  MixFormat: {ac.MixFormat}");
    Console.WriteLine($"  minPeriod={ac.MinimumDevicePeriod / 10000.0:F2}ms defaultPeriod={ac.DefaultDevicePeriod / 10000.0:F2}ms supportsAudioClient3={ac.SupportsAudioClient3}");

    foreach (var rate in rates)
    {
        foreach (var wf in new[] {
            Try(() => new WaveFormatExtensible(rate, 32, 2)),   // PCM32 容器（i24 位完美所需）
            Try(() => new WaveFormat(rate, 24, 2)),
            Try(() => new WaveFormat(rate, 16, 2)),
        })
        {
            if (wf == null) continue;
            try
            {
                WaveFormat? closest = null;
                if (ac.IsFormatSupported(AudioClientShareMode.Exclusive, wf, out closest))
                    Console.WriteLine($"  EXCL OK   {wf.SampleRate}Hz/{wf.BitsPerSample}bit({wf.Encoding})");
                else if (closest != null && closest.SampleRate == wf.SampleRate)
                    Console.WriteLine($"  EXCL ~    {wf.SampleRate}Hz -> closest {closest.BitsPerSample}bit({closest.Encoding})");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  EXCL ERR  {wf.SampleRate}/{wf.BitsPerSample}: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }
    try
    {
        WaveFormat? closest = null;
        var f32 = WaveFormat.CreateIeeeFloatWaveFormat(192000, 2);
        var r = ac.IsFormatSupported(AudioClientShareMode.Exclusive, f32, out closest);
        Console.WriteLine($"  EXCL float32@192k: {r}" + (closest != null ? $" closest={closest}" : ""));
    }
    catch (Exception ex) { Console.WriteLine($"  float probe err: {ex.Message}"); }
    d.Dispose();
}

static T? Try<T>(Func<T> f) where T : class { try { return f(); } catch { return null; } }
