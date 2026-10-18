import copy
import tempfile
import unittest
from pathlib import Path
import numpy as np
import study
from test_definition import CONFIG


class StudyTests(unittest.TestCase):
    def records(self):
        radius=np.linspace(0.0001,100,8193)
        profile=np.column_stack((radius,np.ones((len(radius),5))))
        profiles={case['id']:profile.copy() for case in CONFIG['solver']['cases']}
        reports={case['id']:{'passed':True,'observations':{name:CONFIG['reference'][name]
                  for name in CONFIG['acceptance']['convergence_absolute_bands']}} for case in CONFIG['solver']['cases']}
        return profiles,reports

    def test_aggregate_same_synthetic_values(self):
        profiles,reports=self.records()
        self.assertTrue(study.aggregate(profiles,reports,CONFIG)['passed'])

    def test_aggregate_rejects_nonconvergence(self):
        profiles,reports=self.records()
        reports['domain_outer']['observations']['mass']+=0.001
        self.assertFalse(study.aggregate(profiles,reports,CONFIG)['passed'])

    def test_aggregate_rejects_diverging_refinement(self):
        profiles,reports=self.records()
        reports['resolution_medium']['observations']['mass']+=1e-7
        reports['resolution_fine']['observations']['mass']+=4e-7
        self.assertIn('refinement:mass',study.aggregate(profiles,reports,CONFIG)['failures'])

    def test_aggregate_rejects_profile_drift(self):
        profiles,reports=self.records()
        profiles['origin_large'][:,3]+=0.001
        self.assertIn('convergence:origin_large:profile',study.aggregate(profiles,reports,CONFIG)['failures'])

    def test_nonclobbering_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'evidence.json'
            study.write_json(path,{'value':1})
            with self.assertRaises(FileExistsError):
                study.write_json(path,{'value':2})
            self.assertEqual(path.read_text().count('1'),1)

    def test_digest_tamper(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'freeze.json'
            study.write_json(path,{'synthetic':True})
            with self.assertRaises(ValueError):
                study.authenticate(path,'0'*64)


if __name__=='__main__':
    unittest.main()
