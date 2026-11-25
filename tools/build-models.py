"""Prépare les modèles de détourage pour le site (à lancer une seule fois, ou pour changer de modèle).

Modèles (licence permissive Apache-2.0, aucune obligation AGPL) :
  - ISNet general-use (xuebinqin/DIS), export ONNX de rembg (MIT)
      « isnet »    : poids en float16, calcul en float32 (ordinateurs)
      « isnet-q8 » : poids quantifiés 8 bits (mobiles, 3x plus léger)
  BiRefNet lite (MIT) a été testé : nettement meilleur, mais il demande 6,7 Go de mémoire
  à 1024 px, au-delà de la limite de 4 Go de WebAssembly. Il faudrait un export en 512 px.
Sources : https://github.com/danielgatis/rembg/releases/tag/v0.0.0

Usage : pip install onnx onnxruntime numpy
        python tools/build-models.py <dossier contenant les .onnx téléchargés>
Résultat : site/models/<nom>/part-NN.bin (morceaux gzip de 4 Mo) + site/models/<nom>/manifest.json
"""
import sys, os, gzip, json, hashlib, numpy as np, onnx
from onnx import numpy_helper, helper, TensorProto

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'site', 'models')
CHUNK = 4 * 1024 * 1024

def weights_fp16(path):
    """Poids stockés en float16 (fichier 2x plus léger), calcul en float32 (vitesse et précision intactes)."""
    m = onnx.load(path); g = m.graph; new, casts = [], []
    for init in list(g.initializer):
        if init.data_type == TensorProto.FLOAT and np.prod(init.dims) >= 1024:
            h = numpy_helper.from_array(numpy_helper.to_array(init).astype(np.float16), init.name + '__f16')
            new.append(h)
            casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + '__cast'))
            g.initializer.remove(init)
    g.initializer.extend(new)
    nodes = list(g.node); del g.node[:]; g.node.extend(casts + nodes)
    return m.SerializeToString()

def quant_uint8(path):
    from onnxruntime.quantization import quantize_dynamic, QuantType
    tmp = path + '.q8.onnx'
    quantize_dynamic(path, tmp, weight_type=QuantType.QUInt8, op_types_to_quantize=['Conv'])
    data = open(tmp, 'rb').read(); os.remove(tmp); return data

MODELS = {
    'isnet': dict(file='isnet-general-use.onnx', make=weights_fp16,
                  size=1024, mean=[0.5, 0.5, 0.5], std=[1, 1, 1], output='minmax', curve=[0.2, 0.8],
                  license='Apache-2.0', source='https://github.com/xuebinqin/DIS'),
    'isnet-q8': dict(file='isnet-general-use.onnx', make=quant_uint8,
                     size=1024, mean=[0.5, 0.5, 0.5], std=[1, 1, 1], output='minmax', curve=[0.2, 0.8],
                     license='Apache-2.0', source='https://github.com/xuebinqin/DIS'),
}

for name, cfg in MODELS.items():
    raw = cfg['make'](os.path.join(SRC, cfg['file']))
    gz = gzip.compress(raw, 9, mtime=0)
    d = os.path.join(OUT, name); os.makedirs(d, exist_ok=True)
    for f in os.listdir(d): os.remove(os.path.join(d, f))
    parts = []
    for i in range(0, len(gz), CHUNK):
        part = gz[i:i + CHUNK]
        fn = f'part-{i // CHUNK:02d}-{hashlib.sha256(part).hexdigest()[:10]}.bin'
        open(os.path.join(d, fn), 'wb').write(part); parts.append(fn)
    man = {k: v for k, v in cfg.items() if k not in ('make', 'file')}
    man.update(parts=parts, bytes=len(gz), rawBytes=len(raw))
    json.dump(man, open(os.path.join(d, 'manifest.json'), 'w'), indent=1)
    print(name, f'{len(raw)/1e6:.1f} Mo -> {len(gz)/1e6:.1f} Mo gzip, {len(parts)} morceaux')
