# Native original preparation pixel limit correction

The connected free check downloaded the original set, then failed at
original_metadata with recognition_source_pixel_limit. No provider call ran.
The earlier byte-size fix was insufficient because Sharp still rejected inputs
above 16 million pixels throughout normalization and label preparation.

Guarded original-photo trials now support 64 million pixels per image and
160 million across the set. Existing 12 MiB/file and 40 MiB/set byte limits
remain. Metadata reads headers without decoding; explicit finite pixel bounds
are checked before normalization. Ordinary input decoding retains its 16-million
pixel ceiling. The guarded bound follows normalization, label crops, search
views, marker reading and outgoing provider image preparation. Original storage
bytes/hashes are preserved. Outgoing images retain existing dimensions and byte
caps. This does not create detail or establish product identity.

Validation: 198 offline tests across 17 files, root TypeScript and diff checks
pass. A real 48MP synthetic JPEG passes EXIF normalization, native cropping and
bounded provider preparation. Native crop decoded bytes match direct extraction.
A 192MP set is refused at metadata before normalization. Production guard still
limits decoding to 16MP. These are preparation checks, not field recognition
results. Recheck the saved originals in connected staging before paid analysis.
